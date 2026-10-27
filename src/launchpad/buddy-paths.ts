// The paths of Buddy's routes (decisions F63, F65 and F66): one list for the
// server's routes (buddy-routes.ts) and the page (buddy-client.ts), which
// imports nothing of the server.

export const buddyRoutePaths = Object.freeze({
  read: "/api/buddy",
  start: "/api/buddy/sign-in/start",
  poll: "/api/buddy/sign-in/poll",
  cancel: "/api/buddy/sign-in/cancel",
  signOut: "/api/buddy/sign-out",
  persona: "/api/buddy/persona",
  telegramConnect: "/api/buddy/telegram/connect",
  telegramApprove: "/api/buddy/telegram/approve",
  telegramDisconnect: "/api/buddy/telegram/disconnect",
});
