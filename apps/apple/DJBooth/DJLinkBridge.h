#ifndef DJBOOTH_LINK_BRIDGE_H
#define DJBOOTH_LINK_BRIDGE_H
// Call away from the UI thread. Response is owned JSON; always free it once.
// "api" lists every public Rust server method and protocol helper, generated
// from their signatures. "server.<method>" and "function.<name>" take JSON
// objects with the original Rust argument names and return the Rust result.
// Subscriptions return a handle; server.poll_events drains its bounded Rust
// receiver, reporting lag, and server.unsubscribe releases it. No Swift protocol.
char *djbooth_link_request(const char *operation, const char *input);
void djbooth_link_free(char *value);
#include <stddef.h>
void djbooth_spotify_read(float *left, float *right, size_t frames);
#endif
