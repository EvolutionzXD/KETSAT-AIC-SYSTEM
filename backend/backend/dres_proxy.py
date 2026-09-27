"""Thin proxy around the DRES REST API so the browser never has to talk to
eventretrieval.one (or a competition-day DRES server) directly — that host
is typically self-signed / on a different origin, which the browser's CORS
policy would block. Ported from the PixelPals stack's app/dres.py, which
has been running against a real DRES instance stably.

Implements the 3-step flow from the DRES v2 OpenAPI spec
(dres-dev/DRES doc/oas-client.json), already verified end to end against a
live server (see aic2026-... memory — login/evaluation-list confirmed real):

  1. POST {baseUrl}/api/v2/login                              -> sessionId
  2. GET  {baseUrl}/api/v2/client/evaluation/list?session=...  -> evaluationId
  3. POST {baseUrl}/api/v2/submit/{evaluationId}?session=...   -> submit answer

Submission body shape (POST /api/v2/submit/{evaluationId}):
  KIS / TRAKE:
    {"answerSets":[{"answers":[{"mediaItemName": <VIDEO_ID>, "start": <ms>, "end": <ms>}, ...]}]}
    (TRAKE: one answerSet, N answers — one {mediaItemName, start, end} per
    ordered event/moment, per the spec: "a specific portion of a mediaItem
    is required: provide mediaItemName, start and end".)
  Q&A:
    {"answerSets":[{"answers":[{"text": "<answer>"}]}]}
"""
from __future__ import annotations

from typing import List, Optional

import httpx
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

router = APIRouter(prefix="/api/dres", tags=["dres"])

TIMEOUT = 15.0


def _client(base_url: str) -> httpx.AsyncClient:
    # DRES test/competition servers are often reached over a self-signed
    # cert, so TLS verification is intentionally off for the practice
    # server — matches the source (PixelPals) behavior this was ported from.
    return httpx.AsyncClient(base_url=base_url.rstrip("/"), timeout=TIMEOUT, verify=False)


class DresLoginRequest(BaseModel):
    baseUrl: str
    username: str
    password: str


class TrakeSegment(BaseModel):
    startMs: int
    endMs: int


class DresSubmitRequest(BaseModel):
    baseUrl: str
    session: str
    evaluationId: str
    task: str  # "KIS-T" | "Q&A" | "TRAKE"
    videoId: Optional[str] = None
    startMs: Optional[int] = None
    endMs: Optional[int] = None
    answer: Optional[str] = None  # raw text answer for Q&A
    # TRAKE only: N ordered {startMs, endMs} segments, one per moment in the
    # event chain — one answer per {mediaItemName, start, end} triple inside
    # a single answerSet, not concatenated timestamps.
    trakeSegments: Optional[List[TrakeSegment]] = None


@router.post("/login")
async def dres_login(body: DresLoginRequest):
    async with _client(body.baseUrl) as client:
        try:
            r = await client.post("/api/v2/login", json={"username": body.username, "password": body.password})
        except httpx.RequestError as e:
            raise HTTPException(502, f"Không kết nối được tới DRES: {e}")
    if r.status_code >= 400:
        raise HTTPException(r.status_code, f"DRES từ chối đăng nhập: {r.text}")
    return r.json()


@router.get("/evaluations")
async def dres_evaluations(baseUrl: str, session: str):
    async with _client(baseUrl) as client:
        try:
            r = await client.get("/api/v2/client/evaluation/list", params={"session": session})
        except httpx.RequestError as e:
            raise HTTPException(502, f"Không kết nối được tới DRES: {e}")
    if r.status_code >= 400:
        raise HTTPException(r.status_code, f"DRES lỗi khi lấy danh sách evaluation: {r.text}")
    return r.json()


@router.post("/submit")
async def dres_submit(body: DresSubmitRequest):
    if body.task == "Q&A":
        if not body.answer:
            raise HTTPException(400, "Thiếu câu trả lời (answer) cho câu hỏi Q&A")
        payload = {"answerSets": [{"answers": [{"text": body.answer}]}]}
    elif body.task == "TRAKE":
        if body.videoId is None or not body.trakeSegments:
            raise HTTPException(400, "Thiếu videoId hoặc trakeSegments (danh sách khoảnh khắc) cho TRAKE")
        frame_ids = ",".join(str(seg.startMs) for seg in body.trakeSegments)
        text = f"TR-{body.videoId}-{frame_ids}"
        payload = {
            "answerSets": [{
                "answers": [{"text": text}]
            }]
        }
    else:
        if body.videoId is None or body.startMs is None:
            raise HTTPException(400, "Thiếu videoId/startMs cho câu trả lời KIS")
        payload = {
            "answerSets": [{
                "answers": [{
                    "mediaItemName": body.videoId,
                    "start": body.startMs,
                    "end": body.endMs if body.endMs is not None else body.startMs,
                }]
            }]
        }

    async with _client(body.baseUrl) as client:
        try:
            r = await client.post(
                f"/api/v2/submit/{body.evaluationId}",
                params={"session": body.session},
                json=payload,
            )
        except httpx.RequestError as e:
            raise HTTPException(502, f"Không kết nối được tới DRES: {e}")
    if r.status_code >= 400:
        raise HTTPException(r.status_code, f"DRES từ chối bài nộp: {r.text}")
    try:
        return r.json()
    except Exception:
        return {"status": "ok", "raw": r.text}
