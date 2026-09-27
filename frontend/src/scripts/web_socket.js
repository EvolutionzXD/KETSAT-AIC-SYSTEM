// This file used to hold ~8 WebSocket channels (search, similarity search,
// filter, group search, alerts, shared queries, shared images/VQA input) —
// none of them have a server-side equivalent in backend/app.py (which is
// plain REST, no WebSocket routes at all). All of that has been removed;
// see query_backend.js for the real search flow.
//
// socket_share stays declared (but never connected) purely so
// export.js's `isExportShared && socket_share && socket_share.readyState
// === WebSocket.OPEN` broadcast guard in addImageToExportArea() keeps
// short-circuiting to false instead of throwing a ReferenceError. Real-time
// export sharing between teammates would need a server-side WS route to
// come back — not something this single-user setup has today.
let socket_share;
