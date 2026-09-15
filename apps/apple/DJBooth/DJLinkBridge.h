#ifndef DJBOOTH_LINK_BRIDGE_H
#define DJBOOTH_LINK_BRIDGE_H
// Call away from the UI thread. Response is owned JSON; always free it once.
char *djbooth_link_request(const char *operation, const char *input);
void djbooth_link_free(char *value);
#endif
