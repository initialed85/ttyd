#include <libwebsockets.h>
#include <stdbool.h>
#include <stdio.h>
#include <uv.h>

#include "pty.h"

// client message
#define INPUT '0'
#define RESIZE_TERMINAL '1'
#define PAUSE '2'
#define RESUME '3'
#define JSON_DATA '{'
// A browser paste or drag-and-drop arrives as BEGIN (name and size as JSON), then DATA frames of
// base64, then COMMIT. Base64 keeps every frame text-safe: libwebsockets UTF-8 validates text
// frames, and an arbitrary JPEG is not.
#define UPLOAD_BEGIN '4'
#define UPLOAD_DATA '5'
#define UPLOAD_COMMIT '6'
#define UPLOAD_ABORT '7'

// server message
#define OUTPUT '0'
#define SET_WINDOW_TITLE '1'
#define SET_PREFERENCES '2'
// What this server is willing to do beyond the terminal, so the client does not offer a file paste
// to a readonly pane or one started with uploads disabled.
#define SET_CAPABILITIES '3'
#define UPLOAD_RESULT '4'

// Browser uploads land in <working directory>/<TTYD_UPLOAD_DIR_DEFAULT>, with a timestamp prefix so
// pasting the same screenshot twice does not overwrite the first one.
#define TTYD_UPLOAD_DIR_DEFAULT ".slopyphus/uploads"
#define TTYD_UPLOAD_MAX_BYTES_DEFAULT (8L * 1024 * 1024)
#define TTYD_UPLOAD_MAX_BYTES_LIMIT (64 * 1024 * 1024)

// url paths
struct endpoints {
  char *ws;
  char *index;
  char *token;
  char *parent;
};

extern volatile bool force_exit;
extern struct lws_context *context;
extern struct server *server;
extern struct endpoints endpoints;

struct pss_http {
  char path[128];
  char *buffer;
  char *ptr;
  size_t len;
};

struct pss_tty {
  bool initialized;
  int initial_cmd_index;
  bool authenticated;
  char user[30];
  char address[50];
  char path[128];
  char **args;
  int argc;

  struct lws *wsi;
  char *buffer;
  size_t len;

  pty_process *process;
  pty_buf_t *pty_buf;

  int lws_close_status;

  // One browser upload per connection. up_path is where the bytes land, and the same string is what
  // gets typed into the pty on commit so the program in the pane can open the file.
  FILE *up_file;
  char up_path[512];
  long up_size;      // bytes the client declared
  long up_received;  // bytes actually written
  bool up_failed;
};

typedef struct {
  struct pss_tty *pss;
  bool ws_closed;
} pty_ctx_t;

struct server {
  int client_count;        // client count
  char *prefs_json;        // client preferences
  char *credential;        // encoded basic auth credential
  char *auth_header;       // header name used for auth proxy
  char *index;             // custom index.html
  char *command;           // full command line
  char **argv;             // command with arguments
  int argc;                // command + arguments count
  char *cwd;               // working directory
  int sig_code;            // close signal
  char sig_name[20];       // human readable signal string
  bool url_arg;            // allow client to send cli arguments in URL
  bool writable;           // whether clients to write to the TTY
  bool check_origin;       // whether allow websocket connection from different origin
  bool upload_disabled;    // --disable-upload: refuse browser file uploads outright
  long upload_max_bytes;   // --upload-max-bytes, per single file
  char upload_dir[128];    // directory under the working directory uploads land in
  int max_clients;         // maximum clients to support
  bool once;               // whether accept only one client and exit on disconnection
  bool exit_no_conn;       // whether exit on all clients disconnection
  char socket_path[255];   // UNIX domain socket path
  char terminal_type[30];  // terminal type to report

  uv_loop_t *loop;         // the libuv event loop
};
