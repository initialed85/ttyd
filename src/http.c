#include <libwebsockets.h>
#include <string.h>
#include <zlib.h>

#include "html.h"
#include "server.h"
#include "utils.h"

enum { AUTH_OK, AUTH_FAIL, AUTH_ERROR };

static char *html_cache = NULL;
static size_t html_cache_len = 0;

static int send_unauthorized(struct lws *wsi, unsigned int code, enum lws_token_indexes header) {
  unsigned char buffer[1024 + LWS_PRE], *p, *end;
  p = buffer + LWS_PRE;
  end = p + sizeof(buffer) - LWS_PRE;

  if (lws_add_http_header_status(wsi, code, &p, end) ||
      lws_add_http_header_by_token(wsi, header, (unsigned char *)"Basic realm=\"ttyd\"", 18, &p, end) ||
      lws_add_http_header_content_length(wsi, 0, &p, end) || lws_finalize_http_header(wsi, &p, end) ||
      lws_write(wsi, buffer + LWS_PRE, p - (buffer + LWS_PRE), LWS_WRITE_HTTP_HEADERS) < 0)
    return AUTH_FAIL;

  return lws_http_transaction_completed(wsi) ? AUTH_FAIL : AUTH_ERROR;
}

static int check_auth(struct lws *wsi, struct pss_http *pss) {
  if (server->auth_header != NULL) {
    if (lws_hdr_custom_length(wsi, server->auth_header, strlen(server->auth_header)) > 0) return AUTH_OK;
    return send_unauthorized(wsi, HTTP_STATUS_PROXY_AUTH_REQUIRED, WSI_TOKEN_HTTP_PROXY_AUTHENTICATE);
  }

  if(server->credential != NULL) {
    char buf[256];
    int len = lws_hdr_copy(wsi, buf, sizeof(buf), WSI_TOKEN_HTTP_AUTHORIZATION);
    if (len >= 7 && strstr(buf, "Basic ")) {
      if (!strcmp(buf + 6, server->credential)) return AUTH_OK;
    }
    return send_unauthorized(wsi, HTTP_STATUS_UNAUTHORIZED, WSI_TOKEN_HTTP_WWW_AUTHENTICATE);
  }

  return AUTH_OK;
}

static bool accept_gzip(struct lws *wsi) {
  char buf[256];
  int len = lws_hdr_copy(wsi, buf, sizeof(buf), WSI_TOKEN_HTTP_ACCEPT_ENCODING);
  return len > 0 && strstr(buf, "gzip") != NULL;
}

// The document ttyd serves *is* the client: the terminal bundle is inlined into it, and the file is compiled
// into the binary, so its content changes exactly when the image does - and there is nothing a browser could
// use to ask whether what it holds is still current, because an embedded resource has no Last-Modified, no
// ETag and no conditional path. Without an instruction to the contrary a tab opened before a rollout keeps
// running the bundle it cached, which from the pane looks identical to the fix never having been deployed.
// no-store is the only honest thing to say here, and it also keeps the response out of the back/forward
// cache, which is the other way a stale terminal survives a reload.
static int add_no_store(struct lws *wsi, unsigned char **p, unsigned char *end) {
  return lws_add_http_header_by_token(wsi, WSI_TOKEN_HTTP_CACHE_CONTROL, (unsigned char *)"no-store", 8, p, end);
}

static bool uncompress_html(char **output, size_t *output_len) {
  if (html_cache == NULL || html_cache_len == 0) {
    z_stream stream;
    memset(&stream, 0, sizeof(stream));
    if (inflateInit2(&stream, 16 + 15) != Z_OK) return false;

    html_cache_len = index_html_size;
    html_cache = xmalloc(html_cache_len);

    stream.avail_in = index_html_len;
    stream.avail_out = html_cache_len;
    stream.next_in = (void *)index_html;
    stream.next_out = (void *)html_cache;

    int ret = inflate(&stream, Z_SYNC_FLUSH);
    inflateEnd(&stream);
    if (ret != Z_STREAM_END) {
      free(html_cache);
      html_cache = NULL;
      html_cache_len = 0;
      return false;
    }
  }

  *output = html_cache;
  *output_len = html_cache_len;

  return true;
}

static void pss_buffer_free(struct pss_http *pss) {
  if (pss->buffer != (char *)index_html && pss->buffer != html_cache) free(pss->buffer);
}

static void access_log(struct lws *wsi, const char *path) {
  char rip[50];

  lws_get_peer_simple(lws_get_network_wsi(wsi), rip, sizeof(rip));
  lwsl_notice("HTTP %s - %s\n", path, rip);
}

// The pictures this pane's relay saved, read back over HTTP. tmux stores cells and keeps no copy of an inline
// image - capture-pane -p -e on a pane that has just drawn one reports zero occurrences of the sequence it printed
// - so every repaint (copy-mode, a resize, a pane menu, a reattach) erases the picture and nothing below tmux can
// put it back. The bytes are reachable here instead, which is what lets a browser redraw them from a text marker
// in the grid. Reading is why this route is shaped the way it is: only a name the relay itself would have written
// is ever opened, so `..`, an absolute path, and anything else in the working directory cannot be asked for.
static bool image_name_ok(const char *name) {
  size_t i;
  for (i = 0; i < 10; i++) {
    char c = name[i];
    if (c < '0' || (c > '9' && c < 'a') || c > 'f') return false;  // ten lowercase hex digits, then a dot
  }
  if (name[i++] != '.') return false;
  const char *ext = name + i;
  return strcmp(ext, "png") == 0 || strcmp(ext, "gif") == 0 || strcmp(ext, "bmp") == 0 || strcmp(ext, "jpg") == 0;
}

static const char *image_type(const char *name) {
  if (endswith(name, ".gif")) return "image/gif";
  if (endswith(name, ".bmp")) return "image/bmp";
  if (endswith(name, ".jpg")) return "image/jpeg";
  return "image/png";  // .png is the only name left that image_name_ok accepted
}

int callback_http(struct lws *wsi, enum lws_callback_reasons reason, void *user, void *in, size_t len) {
  struct pss_http *pss = (struct pss_http *)user;
  unsigned char buffer[4096 + LWS_PRE], *p, *end;
  char buf[256];
  bool done = false;

  switch (reason) {
    case LWS_CALLBACK_HTTP:
      access_log(wsi, (const char *)in);
      snprintf(pss->path, sizeof(pss->path), "%s", (const char *)in);
      switch (check_auth(wsi, pss)) {
        case AUTH_OK:
          break;
        case AUTH_FAIL:
          return 0;
        case AUTH_ERROR:
        default:
          return 1;
      }

      p = buffer + LWS_PRE;
      end = p + sizeof(buffer) - LWS_PRE;

      if (strcmp(pss->path, endpoints.token) == 0) {
        const char *credential = server->credential != NULL ? server->credential : "";
        size_t n = sprintf(buf, "{\"token\": \"%s\"}", credential);
        if (lws_add_http_header_status(wsi, HTTP_STATUS_OK, &p, end) ||
            lws_add_http_header_by_token(wsi, WSI_TOKEN_HTTP_CONTENT_TYPE,
                                         (unsigned char *)"application/json;charset=utf-8", 30, &p, end) ||
            lws_add_http_header_content_length(wsi, (unsigned long)n, &p, end) ||
            lws_finalize_http_header(wsi, &p, end) ||
            lws_write(wsi, buffer + LWS_PRE, p - (buffer + LWS_PRE), LWS_WRITE_HTTP_HEADERS) < 0)
          return 1;

        pss->buffer = pss->ptr = strdup(buf);
        pss->len = n;
        lws_callback_on_writable(wsi);
        break;
      }

      // redirects `/base-path` to `/base-path/`
      if (strcmp(pss->path, endpoints.parent) == 0) {
        if (lws_add_http_header_status(wsi, HTTP_STATUS_FOUND, &p, end) ||
            lws_add_http_header_by_token(wsi, WSI_TOKEN_HTTP_LOCATION, (unsigned char *)endpoints.index,
                                         (int)strlen(endpoints.index), &p, end) ||
            lws_add_http_header_content_length(wsi, 0, &p, end) || lws_finalize_http_header(wsi, &p, end) ||
            lws_write(wsi, buffer + LWS_PRE, p - (buffer + LWS_PRE), LWS_WRITE_HTTP_HEADERS) < 0)
          return 1;
        goto try_to_reuse;
      }

      char images_prefix[256];
      snprintf(images_prefix, sizeof(images_prefix), "%s%s", endpoints.index, TTYD_IMAGE_ROUTE);
      if (strncmp(pss->path, images_prefix, strlen(images_prefix)) == 0) {
        const char *name = pss->path + strlen(images_prefix);
        if (!image_name_ok(name)) {
          lws_return_http_status(wsi, HTTP_STATUS_NOT_FOUND, NULL);
          goto try_to_reuse;
        }

        char dir[256], path[512];
        if (getcwd(dir, sizeof(dir)) == NULL || snprintf(path, sizeof(path), "%s/%s/%s", dir, server->image_dir, name) >= (int)sizeof(path)) {
          lws_return_http_status(wsi, HTTP_STATUS_INTERNAL_SERVER_ERROR, NULL);
          goto try_to_reuse;
        }

        // lstat before open, fstat after it, and the two must name the same regular file. A picture has to be a
        // file the relay wrote, not a pointer somebody planted in the directory: the pane's own user can read
        // /etc/passwd from their shell anyway, but a route shaped like "read this picture" should not turn into
        // "read whatever this link points at" because a link appeared, and checking identity after the open closes
        // the gap between the two calls without reaching for an open flag that is not portable.
        //
        // The size ceiling is the upload one: a picture is a file this stack accepts from a browser as well, and a
        // second limit would be a second thing to keep in sync for no benefit.
        struct stat listed, st;
        int fd = -1;
        if (lstat(path, &listed) == 0 && S_ISREG(listed.st_mode) && listed.st_size > 0 &&
            listed.st_size <= server->upload_max_bytes && (fd = open(path, O_RDONLY)) >= 0 &&
            fstat(fd, &st) == 0 && st.st_dev == listed.st_dev && st.st_ino == listed.st_ino && st.st_size > 0 &&
            st.st_size <= server->upload_max_bytes) {
          // the same regular file on both calls, small enough to read in one go
        } else {
          if (fd >= 0) close(fd);
          // Absent, unreadable, a link, and over the limit are answered identically: this route does not report which
          // pictures a pane has.
          lws_return_http_status(wsi, HTTP_STATUS_NOT_FOUND, NULL);
          goto try_to_reuse;
        }

        char *body = xmalloc((size_t)st.st_size);
        ssize_t got = read(fd, body, (size_t)st.st_size);
        close(fd);
        if (got != st.st_size) {
          free(body);
          lws_return_http_status(wsi, HTTP_STATUS_INTERNAL_SERVER_ERROR, NULL);
          goto try_to_reuse;
        }

        const char *ctype = image_type(name);
        // Honest because the name is a hash of the bytes: a name that does not change never names different
        // content, which is what makes a redraw after a repaint cheap.
        static const char *cache = "public, max-age=31536000, immutable";
        if (lws_add_http_header_status(wsi, HTTP_STATUS_OK, &p, end) ||
            lws_add_http_header_by_token(wsi, WSI_TOKEN_HTTP_CONTENT_TYPE, (const unsigned char *)ctype,
                                         (int)strlen(ctype), &p, end) ||
            lws_add_http_header_by_name(wsi, (unsigned char *)"Cache-Control:", (const unsigned char *)cache,
                                        (int)strlen(cache), &p, end) ||
            lws_add_http_header_content_length(wsi, (unsigned long)st.st_size, &p, end) ||
            lws_finalize_http_header(wsi, &p, end) ||
            lws_write(wsi, buffer + LWS_PRE, p - (buffer + LWS_PRE), LWS_WRITE_HTTP_HEADERS) < 0) {
          free(body);
          return 1;
        }

        pss->buffer = pss->ptr = body;
        pss->len = (size_t)st.st_size;
        lws_callback_on_writable(wsi);
        break;
      }

      if (strcmp(pss->path, endpoints.index) != 0) {
        lws_return_http_status(wsi, HTTP_STATUS_NOT_FOUND, NULL);
        goto try_to_reuse;
      }

      const char *content_type = "text/html";
      if (server->index != NULL) {
        // Left on the upstream call. The index-file variant hands header writing to lws, whose signature in
        // the libwebsockets this image builds against is `(wsi, fs_path, content_type, const char
        // *other_headers, int other_headers_len)` - one raw blob whose exact accepted shape is not
        // documented, and guessing it here would put an unverified format into a path that serves a page. No
        // ttyd in this deployment uses --index (docker-entrypoint.sh serves the embedded document), so the
        // no-store guarantee above is the one that actually applies; if a custom index is ever introduced,
        // its cache headers have to be settled against the lws version in the Dockerfile.
        int n = lws_serve_http_file(wsi, server->index, content_type, NULL, 0);
        if (n < 0 || (n > 0 && lws_http_transaction_completed(wsi))) return 1;
      } else {
        char *output = (char *)index_html;
        size_t output_len = index_html_len;
        if (lws_add_http_header_status(wsi, HTTP_STATUS_OK, &p, end) ||
            lws_add_http_header_by_token(wsi, WSI_TOKEN_HTTP_CONTENT_TYPE, (const unsigned char *)content_type, 9, &p,
                                         end) ||
            add_no_store(wsi, &p, end))
          return 1;
#ifdef LWS_WITH_HTTP_STREAM_COMPRESSION
        if (!uncompress_html(&output, &output_len)) return 1;
#else
        if (accept_gzip(wsi)) {
          if (lws_add_http_header_by_token(wsi, WSI_TOKEN_HTTP_CONTENT_ENCODING, (unsigned char *)"gzip", 4, &p, end))
            return 1;
        } else {
          if (!uncompress_html(&output, &output_len)) return 1;
        }
#endif

        if (lws_add_http_header_content_length(wsi, (unsigned long)output_len, &p, end) ||
            lws_finalize_http_header(wsi, &p, end) ||
            lws_write(wsi, buffer + LWS_PRE, p - (buffer + LWS_PRE), LWS_WRITE_HTTP_HEADERS) < 0)
          return 1;

        pss->buffer = pss->ptr = output;
        pss->len = output_len;
        lws_callback_on_writable(wsi);
      }
      break;

    case LWS_CALLBACK_HTTP_WRITEABLE:
      if (!pss->buffer || pss->len == 0) {
        goto try_to_reuse;
      }

      do {
        int n = sizeof(buffer) - LWS_PRE;
        int m = lws_get_peer_write_allowance(wsi);
        if (m == 0) {
          lws_callback_on_writable(wsi);
          return 0;
        } else if (m != -1 && m < n) {
          n = m;
        }
        if (pss->ptr + n > pss->buffer + pss->len) {
          n = (int)(pss->len - (pss->ptr - pss->buffer));
          done = true;
        }
        memcpy(buffer + LWS_PRE, pss->ptr, n);
        pss->ptr += n;
        if (lws_write_http(wsi, buffer + LWS_PRE, (size_t)n) < n) {
          pss_buffer_free(pss);
          return -1;
        }
      } while (!lws_send_pipe_choked(wsi) && !done);

      if (!done && pss->ptr < pss->buffer + pss->len) {
        lws_callback_on_writable(wsi);
        break;
      }

      pss_buffer_free(pss);
      goto try_to_reuse;

    case LWS_CALLBACK_HTTP_FILE_COMPLETION:
      goto try_to_reuse;
#if (defined(LWS_OPENSSL_SUPPORT) || defined(LWS_WITH_TLS)) && !defined(LWS_WITH_MBEDTLS)
    case LWS_CALLBACK_OPENSSL_PERFORM_CLIENT_CERT_VERIFICATION:
      if (!len || (SSL_get_verify_result((SSL *)in) != X509_V_OK)) {
        int err = X509_STORE_CTX_get_error((X509_STORE_CTX *)user);
        int depth = X509_STORE_CTX_get_error_depth((X509_STORE_CTX *)user);
        const char *msg = X509_verify_cert_error_string(err);
        lwsl_err("client certificate verification error: %s (%d), depth: %d\n", msg, err, depth);
        return 1;
      }
      break;
#endif
    default:
      break;
  }

  return 0;

  /* if we're on HTTP1.1 or 2.0, will keep the idle connection alive */
try_to_reuse:
  if (lws_http_transaction_completed(wsi)) return -1;

  return 0;
}
