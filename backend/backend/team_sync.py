"""Real-time team collaboration over WebSocket — presence, shared submission
queue, shared DRES session, TRAKE team coordination, frame marking, shared
search history.

Ported from the PixelPals stack's app/team.py + app/ws_sync.py (same design:
in-memory only, no DB — state resets on backend restart, which is fine for a
contest-day session). The whole team points their frontend at the SAME
running backend instance so everyone's WebSocket connection shares this
process's in-memory state.

Presence (/ws/team) has a REST fallback for networks that block WebSocket
upgrades; the other five channels (/ws/queue, /ws/dres, /ws/trake,
/ws/marking, /ws/history) are WebSocket-only, matching the source design —
each takes a client_id in the path purely for routing/logging symmetry with
the source, the server doesn't currently branch on it.
"""
from __future__ import annotations

import json
import time
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from pydantic import BaseModel

router = APIRouter(prefix="/api/team", tags=["team"])
ws_router = APIRouter(tags=["team-ws"])

ONLINE_WINDOW_SEC = 12
MAX_PICKS = 16


class ConnectionManager:
    def __init__(self) -> None:
        self.active: List[WebSocket] = []

    async def connect(self, ws: WebSocket) -> None:
        await ws.accept()
        self.active.append(ws)

    def disconnect(self, ws: WebSocket) -> None:
        if ws in self.active:
            self.active.remove(ws)

    async def broadcast(self, message: Dict[str, Any]) -> None:
        dead = []
        for ws in self.active:
            try:
                await ws.send_json(message)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self.disconnect(ws)


# ─── Presence (/ws/team) ────────────────────────────────────────────────────

team_manager = ConnectionManager()
PRESENCE: Dict[str, Dict[str, Any]] = {}
PICKS: List[Dict[str, Any]] = []


def _upsert_presence(name: str, status: str = "", color: Optional[str] = None) -> Dict[str, Any]:
    prev = PRESENCE.get(name, {})
    PRESENCE[name] = {
        "name": name,
        "status": status or prev.get("status", ""),
        "color": color or prev.get("color") or "#8b6bff",
        "lastSeen": time.time(),
    }
    return PRESENCE[name]


def _roster_snapshot() -> Dict[str, Any]:
    now = time.time()
    members = []
    for name, p in sorted(PRESENCE.items()):
        members.append({
            "name": p["name"],
            "status": p["status"],
            "color": p["color"],
            "online": (now - p["lastSeen"]) <= ONLINE_WINDOW_SEC,
            "secondsAgo": int(now - p["lastSeen"]),
        })
    return {"type": "roster", "members": members}


def _picks_snapshot() -> Dict[str, Any]:
    return {"type": "picks", "picks": PICKS}


def _add_pick(name: str, color: str, frame: Dict[str, Any]) -> None:
    global PICKS
    PICKS = [p for p in PICKS if not (p["name"] == name and p["frame"].get("id") == frame.get("id"))]
    PICKS.insert(0, {"name": name, "color": color, "frame": frame, "ts": time.time()})
    PICKS = PICKS[:MAX_PICKS]


@ws_router.websocket("/ws/team")
async def team_ws(ws: WebSocket) -> None:
    await team_manager.connect(ws)
    try:
        await ws.send_json(_roster_snapshot())
        await ws.send_json(_picks_snapshot())
        while True:
            raw = await ws.receive_text()
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                continue
            msg_type = msg.get("type")
            if msg_type == "heartbeat":
                name = (msg.get("name") or "").strip()
                if not name:
                    continue
                _upsert_presence(name, msg.get("status", ""), msg.get("color"))
                await team_manager.broadcast(_roster_snapshot())
            elif msg_type == "pick":
                name = (msg.get("name") or "").strip()
                frame = msg.get("frame")
                if not name or not frame:
                    continue
                _add_pick(name, msg.get("color") or "#8b6bff", frame)
                await team_manager.broadcast(_picks_snapshot())
            elif msg_type == "leave":
                name = (msg.get("name") or "").strip()
                if name in PRESENCE:
                    del PRESENCE[name]
                    await team_manager.broadcast(_roster_snapshot())
    except WebSocketDisconnect:
        team_manager.disconnect(ws)


class HeartbeatIn(BaseModel):
    name: str
    status: str = ""
    color: Optional[str] = None


@router.post("/heartbeat")
def heartbeat(body: HeartbeatIn) -> Dict[str, bool]:
    name = body.name.strip()
    if not name:
        return {"ok": False}
    _upsert_presence(name, body.status, body.color)
    return {"ok": True}


@router.get("/roster")
def roster() -> Dict[str, Any]:
    return {"members": _roster_snapshot()["members"]}


class PickIn(BaseModel):
    name: str
    color: Optional[str] = None
    frame: Dict[str, Any]


@router.post("/pick")
def add_pick(body: PickIn) -> Dict[str, bool]:
    if not body.name.strip():
        return {"ok": False}
    _add_pick(body.name.strip(), body.color or "#8b6bff", body.frame)
    return {"ok": True}


@router.get("/picks")
def get_picks() -> Dict[str, Any]:
    return {"picks": PICKS}


# ─── Shared submission queue, DRES session, TRAKE coordination, marking,
#     history (/ws/queue, /ws/dres, /ws/trake, /ws/marking, /ws/history) ────

ws_sync_router = APIRouter(tags=["team-ws-sync"])

search_history_state: List[Any] = []
submission_queue_state: List[Dict[str, Any]] = []
marked_frames_state: Dict[str, List[str]] = {"incorrect": [], "caution": []}

history_manager = ConnectionManager()
queue_manager = ConnectionManager()
marking_manager = ConnectionManager()
dres_manager = ConnectionManager()
trake_manager = ConnectionManager()

dres_state: Dict[str, Any] = {}

TRAKE_VOTE_THRESHOLD = 4  # per-stage frame vote-to-lock threshold; the key (locked video) has no threshold


def _new_trake_state() -> Dict[str, Any]:
    return {
        "lockedVideoId": None,
        "lockedBy": None,
        "votes": [],
        "stages": [],
    }


def _new_stage(index: int, label: Optional[str] = None) -> Dict[str, Any]:
    return {
        "id": "stage_" + str(int(time.time() * 1000)) + "_" + str(index),
        "index": index,
        "label": label or f"GĐ{index + 1}",
        "assignees": [],
        "candidates": [],
        "lockedCandidateId": None,
    }


trake_session_state: Dict[str, Any] = _new_trake_state()


def _maybe_promote_stage_candidate(stage: Dict[str, Any], candidate: Dict[str, Any]) -> None:
    if stage.get("lockedCandidateId") == candidate["id"] and candidate["id"] not in [
        c["id"] for c in stage.get("candidates", [])
    ]:
        stage["lockedCandidateId"] = None


@ws_sync_router.websocket("/ws/history/{client_id}")
async def websocket_history(websocket: WebSocket, client_id: str) -> None:
    await history_manager.connect(websocket)
    await websocket.send_text(json.dumps({"type": "HISTORY_UPDATE", "payload": search_history_state}))
    try:
        while True:
            data = await websocket.receive_text()
            msg = json.loads(data)
            action = msg.get("action")
            if action == "CLEAR_HISTORY":
                search_history_state.clear()
                await history_manager.broadcast({"type": "HISTORY_UPDATE", "payload": search_history_state})
            elif action == "ADD_HISTORY":
                search_history_state.insert(0, msg.get("payload"))
                if len(search_history_state) > 100:
                    search_history_state.pop()
                await history_manager.broadcast({"type": "HISTORY_UPDATE", "payload": search_history_state})
    except WebSocketDisconnect:
        history_manager.disconnect(websocket)


@ws_sync_router.websocket("/ws/queue/{client_id}")
async def websocket_queue(websocket: WebSocket, client_id: str) -> None:
    global submission_queue_state
    await queue_manager.connect(websocket)
    await websocket.send_text(json.dumps({"action": "SYNC_QUEUE", "payload": submission_queue_state}))
    try:
        while True:
            data = await websocket.receive_text()
            msg = json.loads(data)
            action = msg.get("action")

            if action == "ADD_FRAME":
                payload = msg.get("payload")
                if not any(f.get("id") == payload.get("id") for f in submission_queue_state if f.get("id")):
                    payload.setdefault("votes", [])
                    submission_queue_state.insert(0, payload)
                await queue_manager.broadcast(msg)
            elif action == "REMOVE_FRAME":
                frame_id = msg.get("payload", {}).get("id")
                submission_queue_state = [f for f in submission_queue_state if f.get("id") != frame_id]
                await queue_manager.broadcast(msg)
            elif action == "CLEAR_QUEUE":
                submission_queue_state.clear()
                await queue_manager.broadcast(msg)
            elif action == "TOGGLE_PIN":
                frame_name = msg.get("payload", {}).get("frame_name")
                is_pinned = msg.get("payload", {}).get("is_pinned")
                for f in submission_queue_state:
                    if f.get("frame_name") == frame_name:
                        f["is_pinned"] = is_pinned
                await queue_manager.broadcast(msg)
            elif action == "VOTE_FRAME":
                sub_id = msg.get("payload", {}).get("id")
                voter = msg.get("payload", {}).get("voter")
                if sub_id and voter:
                    for f in submission_queue_state:
                        if f.get("id") == sub_id:
                            votes = f.setdefault("votes", [])
                            if voter in votes:
                                votes.remove(voter)
                            else:
                                votes.append(voter)
                            break
                await queue_manager.broadcast({"action": "SYNC_QUEUE", "payload": submission_queue_state})
            elif action == "SUBMIT_DONE":
                sub_id = msg.get("payload", {}).get("id")
                submitted_by = msg.get("payload", {}).get("submittedBy")
                for f in submission_queue_state:
                    if f.get("id") == sub_id:
                        f["dresStatus"] = "done"
                        f["submittedBy"] = submitted_by
                        break
                await queue_manager.broadcast({"action": "SYNC_QUEUE", "payload": submission_queue_state})
    except WebSocketDisconnect:
        queue_manager.disconnect(websocket)


@ws_sync_router.websocket("/ws/marking/{client_id}")
async def websocket_marking(websocket: WebSocket, client_id: str) -> None:
    await marking_manager.connect(websocket)
    await websocket.send_text(json.dumps({"action": "SYNC_MARKING", "payload": marked_frames_state}))
    try:
        while True:
            data = await websocket.receive_text()
            msg = json.loads(data)
            action = msg.get("action")

            if action == "TOGGLE_MARK":
                payload = msg.get("payload", {})
                frame_id = payload.get("frame_name")
                mark_type = payload.get("type")
                marked = payload.get("marked")

                if frame_id in marked_frames_state["incorrect"]:
                    marked_frames_state["incorrect"].remove(frame_id)
                if frame_id in marked_frames_state["caution"]:
                    marked_frames_state["caution"].remove(frame_id)

                if marked and mark_type in marked_frames_state:
                    marked_frames_state[mark_type].append(frame_id)

                await marking_manager.broadcast(msg)
            elif action == "CLEAR_MARKING":
                marked_frames_state["incorrect"].clear()
                marked_frames_state["caution"].clear()
                await marking_manager.broadcast(msg)
    except WebSocketDisconnect:
        marking_manager.disconnect(websocket)


@ws_sync_router.websocket("/ws/dres/{client_id}")
async def websocket_dres(websocket: WebSocket, client_id: str) -> None:
    global dres_state
    await dres_manager.connect(websocket)
    if dres_state:
        await websocket.send_text(json.dumps({"action": "SYNC_DRES", "payload": dres_state}))
    try:
        while True:
            data = await websocket.receive_text()
            msg = json.loads(data)
            action = msg.get("action")

            if action == "UPDATE_DRES":
                dres_state = msg.get("payload", {})
                await dres_manager.broadcast({"action": "SYNC_DRES", "payload": dres_state})
    except WebSocketDisconnect:
        dres_manager.disconnect(websocket)


@ws_sync_router.websocket("/ws/trake/{client_id}")
async def websocket_trake(websocket: WebSocket, client_id: str) -> None:
    """TRAKE team coordination — propose+vote directly, no separate 2-step
    lock flow. Every action mutates trake_session_state and re-broadcasts
    the WHOLE state (small enough to be cheap, avoids delta-ordering bugs)."""
    global trake_session_state
    await trake_manager.connect(websocket)
    await websocket.send_text(json.dumps({"action": "SYNC_TRAKE", "payload": trake_session_state}))
    try:
        while True:
            data = await websocket.receive_text()
            msg = json.loads(data)
            action = msg.get("action")
            payload = msg.get("payload", {}) or {}

            if action == "MAKE_KEY":
                source_frame = payload.get("sourceFrame") or {}
                video_id = (source_frame.get("video") or "").strip()
                actor = (payload.get("madeBy") or "").strip()
                if not video_id or not actor:
                    continue
                trake_session_state["lockedVideoId"] = video_id
                trake_session_state["lockedBy"] = actor
                await trake_manager.broadcast({"action": "SYNC_TRAKE", "payload": trake_session_state})

            elif action == "UNLOCK_VIDEO":
                trake_session_state["lockedVideoId"] = None
                trake_session_state["lockedBy"] = None
                await trake_manager.broadcast({"action": "SYNC_TRAKE", "payload": trake_session_state})

            elif action == "ADD_STAGE":
                idx = len(trake_session_state["stages"])
                trake_session_state["stages"].append(_new_stage(idx, payload.get("label")))
                await trake_manager.broadcast({"action": "SYNC_TRAKE", "payload": trake_session_state})

            elif action == "REMOVE_STAGE":
                stage_id = payload.get("stageId")
                trake_session_state["stages"] = [s for s in trake_session_state["stages"] if s["id"] != stage_id]
                for i, s in enumerate(trake_session_state["stages"]):
                    s["index"] = i
                await trake_manager.broadcast({"action": "SYNC_TRAKE", "payload": trake_session_state})

            elif action == "CLAIM_STAGE":
                stage_id = payload.get("stageId")
                name = (payload.get("name") or "").strip()
                if not stage_id or not name:
                    continue
                for s in trake_session_state["stages"]:
                    if s["id"] == stage_id:
                        assignees = s.setdefault("assignees", [])
                        if name in assignees:
                            assignees.remove(name)
                        else:
                            assignees.append(name)
                        break
                await trake_manager.broadcast({"action": "SYNC_TRAKE", "payload": trake_session_state})

            elif action == "PROPOSE_STAGE_FRAME":
                stage_id = payload.get("stageId")
                proposer = (payload.get("proposedBy") or "").strip()
                kind = payload.get("kind", "time")
                if not stage_id or not proposer:
                    continue
                for s in trake_session_state["stages"]:
                    if s["id"] == stage_id:
                        cand = {
                            "id": "cand_" + str(int(time.time() * 1000)),
                            "kind": kind,
                            "timeMs": payload.get("timeMs"),
                            "thumbUrl": payload.get("thumbUrl"),
                            "imageDataUrl": payload.get("imageDataUrl"),
                            "videoId": payload.get("videoId") or trake_session_state["lockedVideoId"],
                            "proposedBy": proposer,
                            "votes": [proposer],
                            "ts": time.time(),
                        }
                        s["candidates"].append(cand)
                        _maybe_promote_stage_candidate(s, cand)
                        break
                await trake_manager.broadcast({"action": "SYNC_TRAKE", "payload": trake_session_state})

            elif action == "VOTE_TRAKE":
                voter = (payload.get("voter") or "").strip()
                if not voter:
                    continue
                if voter in trake_session_state["votes"]:
                    trake_session_state["votes"].remove(voter)
                else:
                    trake_session_state["votes"].append(voter)
                await trake_manager.broadcast({"action": "SYNC_TRAKE", "payload": trake_session_state})

            elif action == "VOTE_STAGE_FRAME":
                stage_id = payload.get("stageId")
                cand_id = payload.get("candidateId")
                voter = (payload.get("voter") or "").strip()
                if not stage_id or not cand_id or not voter:
                    continue
                for s in trake_session_state["stages"]:
                    if s["id"] == stage_id:
                        for c in s["candidates"]:
                            if c["id"] == cand_id:
                                if voter in c["votes"]:
                                    c["votes"].remove(voter)
                                else:
                                    c["votes"].append(voter)
                                _maybe_promote_stage_candidate(s, c)
                                break
                        break
                await trake_manager.broadcast({"action": "SYNC_TRAKE", "payload": trake_session_state})

            elif action == "LOCK_STAGE_FRAME":
                stage_id = payload.get("stageId")
                cand_id = payload.get("candidateId")
                if not stage_id or not cand_id:
                    continue
                for s in trake_session_state["stages"]:
                    if s["id"] == stage_id:
                        if any(c["id"] == cand_id for c in s["candidates"]):
                            s["lockedCandidateId"] = cand_id
                        break
                await trake_manager.broadcast({"action": "SYNC_TRAKE", "payload": trake_session_state})

            elif action == "REMOVE_STAGE_FRAME":
                stage_id = payload.get("stageId")
                cand_id = payload.get("candidateId")
                for s in trake_session_state["stages"]:
                    if s["id"] == stage_id:
                        s["candidates"] = [c for c in s["candidates"] if c["id"] != cand_id]
                        if s.get("lockedCandidateId") == cand_id:
                            s["lockedCandidateId"] = None
                        break
                await trake_manager.broadcast({"action": "SYNC_TRAKE", "payload": trake_session_state})

            elif action == "UNLOCK_STAGE_FRAME":
                stage_id = payload.get("stageId")
                for s in trake_session_state["stages"]:
                    if s["id"] == stage_id:
                        s["lockedCandidateId"] = None
                        break
                await trake_manager.broadcast({"action": "SYNC_TRAKE", "payload": trake_session_state})

            elif action == "CLEAR_TRAKE":
                trake_session_state = _new_trake_state()
                await trake_manager.broadcast({"action": "SYNC_TRAKE", "payload": trake_session_state})
    except WebSocketDisconnect:
        trake_manager.disconnect(websocket)
