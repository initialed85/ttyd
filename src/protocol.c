#include <ctype.h>
#include <errno.h>
#include <json.h>
#include <libwebsockets.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <time.h>
#include <unistd.h>

#include "pty.h"
#include "server.h"
#include "utils.h"

// initial message list
static char initial_cmds[] = {SET_WINDOW_TITLE, SET_PREFERENCES, SET_CAPABILITIES};

// Uploads only make sense where the client may already write to the terminal: typing a path into a
// readonly pane would be refused anyway, and it would still put bytes on the server's disk.
static bool uploads_available(void) { return !server->upload_disabled && server->writable; }

static void upload_dir_path(char *dir, size_t len) {
  char cwd[512];
  const char *base = server->cwd;
  if (base == NULL || strlen(base) == 0) {
    if (getcwd(cwd, sizeof(cwd)) == NULL)
      cwd[0] = '\0';
    base = cwd;
  }
  snprintf(dir, len, "%s/%s", base, server->upload_dir);
}

// mkdir -p, because a fresh workspace has no upload directory until the first paste.
static bool ensure_directories(const char *path) {
  char copy[512];
  snprintf(copy, sizeof(copy), "%s", path);

  for (char *p = copy + 1; *p != '\0'; p++) {
    if (*p != '/') continue;
    *p = '\0';
    if (mkdir(copy, 0755) != 0 && errno != EEXIST) return false;
    *p = '/';
  }

  if (mkdir(copy, 0755) != 0 && errno != EEXIST) return false;
  return true;
}

// Only a basename survives: a browser can hand over anything the drop source called a name, and the
// name is concatenated straight into a path. Everything outside [A-Za-z0-9._-] becomes '-', leading
// dots are dropped so a name can never become ".", ".." or a hidden-file surprise.
static bool sanitize_file_name(const char *raw, char *out, size_t out_len) {
  const char *base = raw;
  for (const char *p = raw; *p != '\0'; p++) {
    if (*p == '/' || *p == '\\') base = p + 1;
  }

  char *o = out;
  char *end = out + out_len - 1;
  for (const char *p = base; *p != '\0' && o < end; p++) {
    unsigned char c = (unsigned char)*p;
    if (isalnum(c) || c == '.' || c == '-' || c == '_')
      *o++ = (char)c;
    else
      *o++ = '-';
  }
  *o = '\0';

  char *trimmed = out;
  while (*trimmed == '.') trimmed++;
  if (trimmed != out) memmove(out, trimmed, strlen(trimmed) + 1);

  return out[0] != '\0';
}

static void upload_close(struct pss_tty *pss, bool keep_file) {
  if (pss->up_file != NULL) {
    fclose(pss->up_file);
    pss->up_file = NULL;
  }
  // The path is cleared together with the file. A result frame that says ok:false and still names a path
  // is a trap: the client would have a filename for something that no longer exists, and the client is
  // the component that decides what to type into the pane.
  if (!keep_file && pss->up_path[0] != '\0') {
    unlink(pss->up_path);
    pss->up_path[0] = '\0';
  }
}

static void send_upload_result(struct pss_tty *pss, bool ok, const char *reason) {
  char payload[768];
  int n = snprintf(payload, sizeof(payload), "{\"ok\":%s,\"bytes\":%ld,\"path\":\"%s\",\"reason\":\"%s\"}",
                   ok ? "true" : "false", pss->up_received, pss->up_path, reason != NULL ? reason : "");
  if (n <= 0) return;

  char *message = xmalloc(LWS_PRE + 1 + (size_t)n);
  char *ptr = message + LWS_PRE;
  *ptr = UPLOAD_RESULT;
  memcpy(ptr + 1, payload, (size_t)n);

  if (lws_write(pss->wsi, (unsigned char *)ptr, (size_t)n + 1, LWS_WRITE_BINARY) < n + 1)
    lwsl_err("write UPLOAD_RESULT to WS\n");

  free(message);
}

static void upload_begin(struct pss_tty *pss, const char *json, size_t len) {
  pss->up_path[0] = '\0';
  pss->up_size = 0;
  pss->up_received = 0;
  pss->up_failed = false;

  if (pss->up_file != NULL) {
    upload_close(pss, false);
    send_upload_result(pss, false, "previous upload abandoned");
  }

  if (!uploads_available()) {
    send_upload_result(pss, false, server->upload_disabled ? "uploads are disabled" : "pane is readonly");
    return;
  }

  json_tokener *tok = json_tokener_new();
  json_object *obj = json_tokener_parse_ex(tok, json, (int)len);
  json_object *o = NULL;
  const char *name = NULL;
  long size = 0;
  if (obj != NULL && json_object_object_get_ex(obj, "name", &o)) name = json_object_get_string(o);
  if (obj != NULL && json_object_object_get_ex(obj, "size", &o)) size = (long)json_object_get_int64(o);
  json_object_put(obj);
  json_tokener_free(tok);

  if (name == NULL || size <= 0) {
    send_upload_result(pss, false, "expected a name and a positive size");
    return;
  }
  if (size > server->upload_max_bytes) {
    send_upload_result(pss, false, "file is larger than the upload limit");
    return;
  }

  char safe_name[128];
  if (!sanitize_file_name(name, safe_name, sizeof(safe_name))) {
    send_upload_result(pss, false, "file name has nothing usable in it");
    return;
  }

  char dir[512];
  upload_dir_path(dir, sizeof(dir));
  if (!ensure_directories(dir)) {
    lwsl_err("uploads: mkdir %s: %s\n", dir, strerror(errno));
    send_upload_result(pss, false, "could not create the upload directory");
    return;
  }

  char stamp[32];
  time_t now = time(NULL);
  struct tm tm;
  localtime_r(&now, &tm);
  strftime(stamp, sizeof(stamp), "%Y%m%d-%H%M%S", &tm);

  // A paste and a drop of the same file in the same second must not clobber each other, so the open
  // is exclusive and a counter walks the collisions.
  for (int attempt = 0; attempt < 100; attempt++) {
    if (attempt == 0)
      snprintf(pss->up_path, sizeof(pss->up_path), "%s/%s-%s", dir, stamp, safe_name);
    else
      snprintf(pss->up_path, sizeof(pss->up_path), "%s/%s-%s-%d", dir, stamp, safe_name, attempt);

    pss->up_file = fopen(pss->up_path, "wx");
    if (pss->up_file != NULL) break;
    if (errno != EEXIST) {
      lwsl_err("uploads: open %s: %s\n", pss->up_path, strerror(errno));
      pss->up_path[0] = '\0';
      send_upload_result(pss, false, "could not open the upload file");
      return;
    }
  }

  if (pss->up_file == NULL) {
    pss->up_path[0] = '\0';
    send_upload_result(pss, false, "too many files with that name in this second");
    return;
  }

  pss->up_size = size;
  lwsl_notice("upload started: %s (%ld bytes)\n", pss->up_path, size);
}

static void upload_data(struct pss_tty *pss, const char *b64, size_t len) {
  if (pss->up_file == NULL) return;  // a transfer the client never began, or one already refused

  size_t cap = len / 4 * 3 + 4;
  char *decoded = xmalloc(cap);
  int n = lws_b64_decode_string(b64, decoded, cap);
  if (n <= 0) {
    free(decoded);
    pss->up_failed = true;
    upload_close(pss, false);
    send_upload_result(pss, false, "upload chunk was not valid base64");
    return;
  }

  if ((long)n > pss->up_size - pss->up_received) {
    // Named numbers, because "the client declared X and sent Y" is the difference between a client bug,
    // a proxy splitting a frame, and a size that changed between the paste and the transfer - and without
    // them the only evidence is a refusal the client prints and nobody can interpret.
    lwsl_err("uploads: a %ld byte chunk overran a %ld byte declaration (%ld written so far to %s)\n", (long)n,
             pss->up_size - pss->up_received, pss->up_received, pss->up_path);
    free(decoded);
    pss->up_failed = true;
    upload_close(pss, false);
    send_upload_result(pss, false, "more bytes arrived than the client declared");
    return;
  }

  size_t written = fwrite(decoded, 1, (size_t)n, pss->up_file);
  free(decoded);
  pss->up_received += (long)written;

  if (written != (size_t)n) {
    pss->up_failed = true;
    upload_close(pss, false);
    send_upload_result(pss, false, "the workspace refused the write");
  }
}

static void upload_commit(struct pss_tty *pss) {
  if (pss->up_file == NULL) return;  // nothing in flight, and no error to report for it

  bool complete = !pss->up_failed && pss->up_received == pss->up_size;
  fclose(pss->up_file);
  pss->up_file = NULL;

  if (!complete) {
    upload_close(pss, false);
    pss->up_received = 0;
    send_upload_result(pss, false, "the transfer stopped before the declared size");
    return;
  }

  lwsl_notice("upload written: %s (%ld bytes)\n", pss->up_path, pss->up_received);
  send_upload_result(pss, true, "");

  // The whole point of the detour through the websocket: the path is handed to the program in the
  // pane as if the user had typed it, which is how a TUI such as Pi gets a file it can open.
  if (pss->process != NULL && server->writable) {
    size_t path_len = strlen(pss->up_path);
    // A space follows the path. A paste is nearly always the start of a sentence rather than its end -
    // "look at <path> and tell me what is wrong" - and without the separator the user's own typing gets
    // glued onto the filename, which is the kind of thing that reads as a broken feature the first time
    // it happens.
    char *typed = xmalloc(path_len + 1);
    memcpy(typed, pss->up_path, path_len);
    typed[path_len] = ' ';
    int err = pty_write(pss->process, pty_buf_init(typed, path_len + 1));
    if (err) lwsl_err("uploads: pty_write: %s (%s)\n", uv_err_name(err), uv_strerror(err));
  }

  pss->up_received = 0;
  pss->up_path[0] = '\0';
}


static int send_initial_message(struct lws *wsi, int index) {
  unsigned char message[LWS_PRE + 1 + 4096];
  unsigned char *p = &message[LWS_PRE];
  char buffer[128];
  int n = 0;

  char cmd = initial_cmds[index];
  switch (cmd) {
    case SET_WINDOW_TITLE:
      gethostname(buffer, sizeof(buffer) - 1);
      n = sprintf((char *)p, "%c%s (%s)", cmd, server->command, buffer);
      break;
    case SET_PREFERENCES:
      n = sprintf((char *)p, "%c%s", cmd, server->prefs_json);
      break;
    case SET_CAPABILITIES: {
      char dir[512];
      upload_dir_path(dir, sizeof(dir));
      n = sprintf((char *)p, "%c{\"upload\":%s,\"uploadMaxBytes\":%ld,\"uploadDir\":\"%s\"}", cmd,
                  uploads_available() ? "true" : "false", server->upload_max_bytes, dir);
      break;
    }
    default:
      break;
  }

  return lws_write(wsi, p, (size_t)n, LWS_WRITE_BINARY);
}

static json_object *parse_window_size(const char *buf, size_t len, uint16_t *cols, uint16_t *rows) {
  json_tokener *tok = json_tokener_new();
  json_object *obj = json_tokener_parse_ex(tok, buf, len);
  struct json_object *o = NULL;

  if (json_object_object_get_ex(obj, "columns", &o)) *cols = (uint16_t)json_object_get_int(o);
  if (json_object_object_get_ex(obj, "rows", &o)) *rows = (uint16_t)json_object_get_int(o);

  json_tokener_free(tok);
  return obj;
}

static bool check_host_origin(struct lws *wsi) {
  char buf[256];
  memset(buf, 0, sizeof(buf));
  int len = lws_hdr_copy(wsi, buf, (int)sizeof(buf), WSI_TOKEN_ORIGIN);
  if (len <= 0) return false;

  const char *prot, *address, *path;
  int port;
  if (lws_parse_uri(buf, &prot, &address, &port, &path)) return false;
  if (port == 80 || port == 443) {
    sprintf(buf, "%s", address);
  } else {
    sprintf(buf, "%s:%d", address, port);
  }

  char host_buf[256];
  memset(host_buf, 0, sizeof(host_buf));
  len = lws_hdr_copy(wsi, host_buf, (int)sizeof(host_buf), WSI_TOKEN_HOST);

  return len > 0 && strcasecmp(buf, host_buf) == 0;
}

static pty_ctx_t *pty_ctx_init(struct pss_tty *pss) {
  pty_ctx_t *ctx = xmalloc(sizeof(pty_ctx_t));
  ctx->pss = pss;
  ctx->ws_closed = false;
  return ctx;
}

static void pty_ctx_free(pty_ctx_t *ctx) { free(ctx); }

static void process_read_cb(pty_process *process, pty_buf_t *buf, bool eof) {
  pty_ctx_t *ctx = (pty_ctx_t *)process->ctx;
  if (ctx->ws_closed) {
    pty_buf_free(buf);
    return;
  }

  if (eof && !process_running(process))
    ctx->pss->lws_close_status = process->exit_code == 0 ? 1000 : 1006;
  else
    ctx->pss->pty_buf = buf;
  lws_callback_on_writable(ctx->pss->wsi);
}

static void process_exit_cb(pty_process *process) {
  pty_ctx_t *ctx = (pty_ctx_t *)process->ctx;
  if (ctx->ws_closed) {
    lwsl_notice("process killed with signal %d, pid: %d\n", process->exit_signal, process->pid);
    goto done;
  }

  lwsl_notice("process exited with code %d, pid: %d\n", process->exit_code, process->pid);
  ctx->pss->process = NULL;
  ctx->pss->lws_close_status = process->exit_code == 0 ? 1000 : 1006;
  lws_callback_on_writable(ctx->pss->wsi);

done:
  pty_ctx_free(ctx);
}

static char **build_args(struct pss_tty *pss) {
  int i, n = 0;
  char **argv = xmalloc((server->argc + pss->argc + 1) * sizeof(char *));

  for (i = 0; i < server->argc; i++) {
    argv[n++] = server->argv[i];
  }

  for (i = 0; i < pss->argc; i++) {
    argv[n++] = pss->args[i];
  }

  argv[n] = NULL;

  return argv;
}

static char **build_env(struct pss_tty *pss) {
  int i = 0, n = 2;
  char **envp = xmalloc(n * sizeof(char *));

  // TERM
  envp[i] = xmalloc(36);
  snprintf(envp[i], 36, "TERM=%s", server->terminal_type);
  i++;

  // TTYD_USER
  if (strlen(pss->user) > 0) {
    envp = xrealloc(envp, (++n) * sizeof(char *));
    envp[i] = xmalloc(40);
    snprintf(envp[i], 40, "TTYD_USER=%s", pss->user);
    i++;
  }

  envp[i] = NULL;

  return envp;
}

static bool spawn_process(struct pss_tty *pss, uint16_t columns, uint16_t rows) {
  pty_process *process = process_init((void *)pty_ctx_init(pss), server->loop, build_args(pss), build_env(pss));
  if (server->cwd != NULL) process->cwd = strdup(server->cwd);
  if (columns > 0) process->columns = columns;
  if (rows > 0) process->rows = rows;
  if (pty_spawn(process, process_read_cb, process_exit_cb) != 0) {
    lwsl_err("pty_spawn: %d (%s)\n", errno, strerror(errno));
    process_free(process);
    return false;
  }
  lwsl_notice("started process, pid: %d\n", process->pid);
  pss->process = process;
  lws_callback_on_writable(pss->wsi);

  return true;
}

static void wsi_output(struct lws *wsi, pty_buf_t *buf) {
  if (buf == NULL) return;
  char *message = xmalloc(LWS_PRE + 1 + buf->len);
  char *ptr = message + LWS_PRE;

  *ptr = OUTPUT;
  memcpy(ptr + 1, buf->base, buf->len);
  size_t n = buf->len + 1;

  if (lws_write(wsi, (unsigned char *)ptr, n, LWS_WRITE_BINARY) < n) {
    lwsl_err("write OUTPUT to WS\n");
  }

  free(message);
}

static bool check_auth(struct lws *wsi, struct pss_tty *pss) {
  if (server->auth_header != NULL) {
    return lws_hdr_custom_copy(wsi, pss->user, sizeof(pss->user), server->auth_header, strlen(server->auth_header)) > 0;
  }

  if (server->credential != NULL) {
    char buf[256];
    size_t n = lws_hdr_copy(wsi, buf, sizeof(buf), WSI_TOKEN_HTTP_AUTHORIZATION);
    return n >= 7 && strstr(buf, "Basic ") && !strcmp(buf + 6, server->credential);
  }

  return true;
}

int callback_tty(struct lws *wsi, enum lws_callback_reasons reason, void *user, void *in, size_t len) {
  struct pss_tty *pss = (struct pss_tty *)user;
  char buf[256];
  size_t n = 0;

  switch (reason) {
    case LWS_CALLBACK_FILTER_PROTOCOL_CONNECTION:
      if (server->once && server->client_count > 0) {
        lwsl_warn("refuse to serve WS client due to the --once option.\n");
        return 1;
      }
      if (server->max_clients > 0 && server->client_count == server->max_clients) {
        lwsl_warn("refuse to serve WS client due to the --max-clients option.\n");
        return 1;
      }
      if (!check_auth(wsi, pss)) return 1;

      n = lws_hdr_copy(wsi, pss->path, sizeof(pss->path), WSI_TOKEN_GET_URI);
#if defined(LWS_ROLE_H2)
      if (n <= 0) n = lws_hdr_copy(wsi, pss->path, sizeof(pss->path), WSI_TOKEN_HTTP_COLON_PATH);
#endif
      if (strncmp(pss->path, endpoints.ws, n) != 0) {
        lwsl_warn("refuse to serve WS client for illegal ws path: %s\n", pss->path);
        return 1;
      }

      if (server->check_origin && !check_host_origin(wsi)) {
        lwsl_warn(
            "refuse to serve WS client from different origin due to the "
            "--check-origin option.\n");
        return 1;
      }
      break;

    case LWS_CALLBACK_ESTABLISHED:
      pss->initialized = false;
      pss->authenticated = false;
      pss->wsi = wsi;
      pss->lws_close_status = LWS_CLOSE_STATUS_NOSTATUS;

      if (server->url_arg) {
        while (lws_hdr_copy_fragment(wsi, buf, sizeof(buf), WSI_TOKEN_HTTP_URI_ARGS, n++) > 0) {
          if (strncmp(buf, "arg=", 4) == 0) {
            pss->args = xrealloc(pss->args, (pss->argc + 1) * sizeof(char *));
            pss->args[pss->argc] = strdup(&buf[4]);
            pss->argc++;
          }
        }
      }

      server->client_count++;

      lws_get_peer_simple(lws_get_network_wsi(wsi), pss->address, sizeof(pss->address));
      lwsl_notice("WS   %s - %s, clients: %d\n", pss->path, pss->address, server->client_count);
      break;

    case LWS_CALLBACK_SERVER_WRITEABLE:
      if (!pss->initialized) {
        if (pss->initial_cmd_index == sizeof(initial_cmds)) {
          pss->initialized = true;
          pty_resume(pss->process);
          break;
        }
        if (send_initial_message(wsi, pss->initial_cmd_index) < 0) {
          lwsl_err("failed to send initial message, index: %d\n", pss->initial_cmd_index);
          lws_close_reason(wsi, LWS_CLOSE_STATUS_UNEXPECTED_CONDITION, NULL, 0);
          return -1;
        }
        pss->initial_cmd_index++;
        lws_callback_on_writable(wsi);
        break;
      }

      if (pss->lws_close_status > LWS_CLOSE_STATUS_NOSTATUS) {
        lws_close_reason(wsi, pss->lws_close_status, NULL, 0);
        return 1;
      }

      if (pss->pty_buf != NULL) {
        wsi_output(wsi, pss->pty_buf);
        pty_buf_free(pss->pty_buf);
        pss->pty_buf = NULL;
        pty_resume(pss->process);
      }
      break;

    case LWS_CALLBACK_RECEIVE:
      if (pss->buffer == NULL) {
        // One byte more than the message, and a terminator written at the end of it. A command handler
        // that takes the payload as a C string has no length to be given: the base64 decoder reads to a
        // NUL. Without the terminator a frame that happens to be followed in the buffer by the next frame
        // decodes a few bytes of *that*, which looks like a client sending more than it declared. Measured
        // with uploads sent back to back, the way a browser sends them.
        pss->buffer = xmalloc(len + 1);
        pss->len = len;
        memcpy(pss->buffer, in, len);
        pss->buffer[pss->len] = '\0';
      } else {
        pss->buffer = xrealloc(pss->buffer, pss->len + len + 1);
        memcpy(pss->buffer + pss->len, in, len);
        pss->len += len;
        pss->buffer[pss->len] = '\0';
      }

      const char command = pss->buffer[0];

      // check auth
      if (server->credential != NULL && !pss->authenticated && command != JSON_DATA) {
        lwsl_warn("WS client not authenticated\n");
        return 1;
      }

      // check if there are more fragmented messages
      if (lws_remaining_packet_payload(wsi) > 0 || !lws_is_final_fragment(wsi)) {
        return 0;
      }

      switch (command) {
        case INPUT:
          if (!server->writable) break;
          int err = pty_write(pss->process, pty_buf_init(pss->buffer + 1, pss->len - 1));
          if (err) {
            lwsl_err("uv_write: %s (%s)\n", uv_err_name(err), uv_strerror(err));
            return -1;
          }
          break;
        case RESIZE_TERMINAL:
          if (pss->process == NULL) break;
          json_object_put(
              parse_window_size(pss->buffer + 1, pss->len - 1, &pss->process->columns, &pss->process->rows));
          pty_resize(pss->process);
          break;
        case PAUSE:
          pty_pause(pss->process);
          break;
        case RESUME:
          pty_resume(pss->process);
          break;
        case UPLOAD_BEGIN:
          upload_begin(pss, pss->buffer + 1, pss->len - 1);
          break;
        case UPLOAD_DATA:
          upload_data(pss, pss->buffer + 1, pss->len - 1);
          break;
        case UPLOAD_COMMIT:
          upload_commit(pss);
          break;
        case UPLOAD_ABORT:
          // The client sends this when it gives up mid-transfer. Silence is deliberate: either there
          // is something to discard, or the server already reported the failure.
          upload_close(pss, false);
          pss->up_path[0] = '\0';
          pss->up_received = 0;
          break;
        case JSON_DATA:
          if (pss->process != NULL) break;
          uint16_t columns = 0;
          uint16_t rows = 0;
          json_object *obj = parse_window_size(pss->buffer, pss->len, &columns, &rows);
          if (server->credential != NULL) {
            struct json_object *o = NULL;
            if (json_object_object_get_ex(obj, "AuthToken", &o)) {
              const char *token = json_object_get_string(o);
              if (token != NULL && !strcmp(token, server->credential))
                pss->authenticated = true;
              else
                lwsl_warn("WS authentication failed with token: %s\n", token);
            }
            if (!pss->authenticated) {
              json_object_put(obj);
              lws_close_reason(wsi, LWS_CLOSE_STATUS_POLICY_VIOLATION, NULL, 0);
              return -1;
            }
          }
          json_object_put(obj);
          if (!spawn_process(pss, columns, rows)) return 1;
          break;
        default:
          lwsl_warn("ignored unknown message type: %c\n", command);
          break;
      }

      if (pss->buffer != NULL) {
        free(pss->buffer);
        pss->buffer = NULL;
      }
      break;

    case LWS_CALLBACK_CLOSED:
      if (pss->wsi == NULL) break;

      server->client_count--;
      lwsl_notice("WS closed from %s, clients: %d\n", pss->address, server->client_count);
      if (pss->buffer != NULL) free(pss->buffer);
      if (pss->pty_buf != NULL) pty_buf_free(pss->pty_buf);
      // A client that drops mid-transfer must not leave a half-written image in the workspace.
      if (pss->up_file != NULL) upload_close(pss, false);
      for (int i = 0; i < pss->argc; i++) {
        free(pss->args[i]);
      }

      if (pss->process != NULL) {
        ((pty_ctx_t *)pss->process->ctx)->ws_closed = true;
        if (process_running(pss->process)) {
          pty_pause(pss->process);
          lwsl_notice("killing process, pid: %d\n", pss->process->pid);
          pty_kill(pss->process, server->sig_code);
        }
      }

      if ((server->once || server->exit_no_conn) && server->client_count == 0) {
        lwsl_notice("exiting due to the --once/--exit-no-conn option.\n");
        force_exit = true;
        lws_cancel_service(context);
        exit(0);
      }
      break;

    default:
      break;
  }

  return 0;
}
