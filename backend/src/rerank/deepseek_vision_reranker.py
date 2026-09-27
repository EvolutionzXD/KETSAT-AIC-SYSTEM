"""Optional DeepSeek Vision critic for a bounded frame shortlist."""
from __future__ import annotations

import base64
from dataclasses import dataclass
from io import BytesIO
import json
import re
import time
from typing import Any, Callable, Dict, List, Mapping, Optional, Sequence
from urllib import request

from loguru import logger
from PIL import Image, ImageDraw


VisionTransport = Callable[
    [str, Mapping[str, str], Mapping[str, Any], float], Mapping[str, Any]
]


@dataclass
class VisionRerankOutcome:
    candidates: List[Dict[str, Any]]
    applied: bool
    reason: str
    latency_ms: float


@dataclass
class TrakeVisionOutcome:
    frame_ids: List[Optional[int]]
    confidences: List[float]
    applied: bool
    reason: str
    latency_ms: float


class DeepSeekVisionReranker:
    def __init__(self, api_key: str, *, model: str, base_url: str,
                 frame_resolver: Callable[[str, int], Any], image_size: int = 640,
                 jpeg_quality: int = 68,
                 transport: Optional[VisionTransport] = None) -> None:
        self.api_key = api_key
        self.model = model
        self.base_url = base_url.rstrip("/")
        self.frame_resolver = frame_resolver
        self.image_size = image_size
        self.jpeg_quality = jpeg_quality
        self._transport = transport

    def _data_url(self, path: Any) -> str:
        with Image.open(path) as image:
            return self._image_data_url(image)

    def _image_data_url(
        self,
        image: Image.Image,
        *,
        max_size: Optional[int] = None,
    ) -> str:
        """Encode an in-memory image without leaking temporary files."""
        image = image.convert("RGB")
        limit = int(max_size or self.image_size)
        image.thumbnail((limit, limit))
        buffer = BytesIO()
        image.save(
            buffer,
            format="JPEG",
            quality=self.jpeg_quality,
            optimize=True,
        )
        return "data:image/jpeg;base64," + base64.b64encode(
            buffer.getvalue()
        ).decode("ascii")

    def _timeline_sheet_data_url(
        self,
        rows: Sequence[Mapping[str, Any]],
        paths: Sequence[Any],
        *,
        start_index: int,
    ) -> Optional[str]:
        """Encode one chronological page with globally numbered frame tiles."""
        if not rows or len(rows) != len(paths):
            return None
        tile_width = max(480, min(560, int(self.image_size)))
        image_height = int(round(tile_width * 9 / 16))
        header_height = 38
        tile_height = image_height + header_height
        columns = 3
        strip = Image.new(
            "RGB",
            (
                tile_width * columns,
                tile_height * ((len(rows) + columns - 1) // columns),
            ),
            "white",
        )
        draw = ImageDraw.Draw(strip)
        loaded = 0
        for index, (row, path) in enumerate(zip(rows, paths)):
            try:
                with Image.open(path) as source:
                    image = source.convert("RGB")
                    image.thumbnail(
                        (tile_width, tile_height - header_height)
                    )
                    image = image.copy()
            except Exception:
                continue
            x = (index % columns) * tile_width
            y = (index // columns) * tile_height
            draw.rectangle(
                (x, y, x + tile_width - 1, y + header_height - 1),
                fill="black",
            )
            global_index = start_index + index
            frame_id = row.get("frame_id", "?")
            try:
                timestamp = float(row.get("timestamp_seconds", 0.0))
            except (TypeError, ValueError):
                timestamp = 0.0
            marker = " ANCHOR" if row.get("_anchor_reference") else ""
            draw.text(
                (x + 7, y + 10),
                f"#{global_index}  F{frame_id}  {timestamp:.1f}s{marker}",
                fill="white",
            )
            frame_canvas = Image.new(
                "RGB", (tile_width, image_height), "black"
            )
            frame_canvas.paste(
                image,
                ((tile_width - image.width) // 2, (image_height - image.height) // 2),
            )
            strip.paste(frame_canvas, (x, y + header_height))
            loaded += 1
        if not loaded:
            return None
        return self._image_data_url(strip, max_size=1800)

    def _event_focus_data_url(
        self,
        path: Any,
        event: str,
    ) -> Optional[str]:
        """Encode an enlarged action crop for exact temporal decisions."""
        text = str(event or "").casefold()
        if any(
            token in text
            for token in ("lân", "lion", "pole", "poles", "trụ", "feet", "chân")
        ):
            box_fraction = (0.22, 0.08, 0.82, 1.0)
        elif any(
            token in text
            for token in ("gong", "kẻng", "mallet", "dùi", "drumstick")
        ):
            box_fraction = (0.0, 0.0, 0.36, 0.55)
        else:
            return None
        try:
            with Image.open(path) as source:
                image = source.convert("RGB")
                width, height = image.size
                left, top, right, bottom = box_fraction
                crop = image.crop((
                    int(width * left),
                    int(height * top),
                    int(width * right),
                    int(height * bottom),
                ))
                longest = max(crop.size)
                if longest < self.image_size:
                    scale = min(2.0, float(self.image_size) / float(longest))
                    crop = crop.resize(
                        (int(crop.width * scale), int(crop.height * scale))
                    )
                return self._image_data_url(crop)
        except Exception:
            return None

    @staticmethod
    def _trake_event_requirements(event: str) -> str:
        """Turn common TRAKE wording into an explicit visual checklist."""
        text = str(event or "").casefold()
        requirements = [
            "Every condition in the event must be visible in this same frame; "
            "never combine evidence from different candidates.",
        ]
        if any(marker in text for marker in (
            "cảnh đầu tiên", "cảnh 1", "cảnh 2", "cảnh 3", "cảnh 4",
            "first scene", "scene 1", "scene 2", "scene 3", "scene 4",
        )):
            requirements.append(
                "Interpret 'scene' as a distinct shot/action state. Do not "
                "count a fleeting object at the edge, a previous shot, or a "
                "transition merely because the object is already somewhere "
                "in the image."
            )
        if any(marker in text for marker in (
            "cận cảnh", "cảnh cận", "close-up", "close up", "closeup",
        )):
            requirements.append(
                "'Close-up' is mandatory: the named subject must occupy a "
                "substantial part of the image and the camera framing must be "
                "close; a wide shot with the subject in the background is false."
            )
        if any(marker in text for marker in (
            "xe tải", "trên xe", "truck", "lorry", "on the truck",
        )):
            requirements.append(
                "'On the truck' is mandatory: the truck body/bed must be "
                "visibly identifiable and the named objects must be on it, not "
                "merely near people, on the ground, or in an unrelated shot."
            )
        if any(marker in text for marker in (
            "xếp chồng", "chồng", "stack", "stacked", "pile",
        )):
            requirements.append(
                "'Stacked' is mandatory: multiple objects must visibly form the "
                "described physical stack, not just appear separately."
            )
        if any(marker in text for marker in (
            "trái ", "quả ", "fruit", "sầu riêng", "măng cụt", "bưởi",
            "dâu bòn bon", "durian", "mangosteen", "pomelo", "longan",
        )):
            requirements.append(
                "A named fruit/object must be clearly identifiable as that "
                "specific item; generic foliage, an ambiguous shape, or a "
                "different fruit does not satisfy the event."
            )
        if any(marker in text for marker in (
            "dán niêm phong", "niêm phong", "seal", "sealing", "tape",
        )):
            requirements.append(
                "For sealing, the sealing action and the box being sealed must "
                "be visible; people merely standing beside a box are false."
            )
        if any(marker in text for marker in (
            "nhấc", "nâng", "xếp lên", "lift", "pick up", "place", "load",
        )):
            requirements.append(
                "For a pick-up/placement/loading action, show the stated action "
                "or its required final placement, not only an already-static "
                "object with no evidence of the described relation."
            )
        return "Mandatory checklist:\n- " + "\n- ".join(requirements)

    def _post_json(self, payload: Mapping[str, Any], timeout: float) -> Mapping[str, Any]:
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }
        if self._transport is not None:
            return self._transport(
                self.base_url + "/chat/completions", headers, payload, timeout
            )
        req = request.Request(
            self.base_url + "/chat/completions",
            data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
            method="POST",
            headers=headers,
        )
        with request.urlopen(req, timeout=timeout) as response:
            return json.loads(response.read().decode("utf-8"))

    @staticmethod
    def _parse_json_content(data: Mapping[str, Any]) -> Mapping[str, Any]:
        raw = data["choices"][0]["message"]["content"]
        if isinstance(raw, Mapping):
            return raw
        text = str(raw).strip()
        fence = chr(96) * 3
        if text.startswith(fence):
            lines = text.splitlines()
            if lines and lines[0].startswith(fence):
                lines = lines[1:]
            if lines and lines[-1].strip() == fence:
                lines = lines[:-1]
            text = "\n".join(lines).strip()
        parsed = json.loads(text)
        if not isinstance(parsed, Mapping):
            raise ValueError("response JSON is not an object")
        return parsed

    def rerank_trake_window(
        self,
        anchor_query: str,
        events: Sequence[str],
        candidates: Sequence[Mapping[str, Any]],
        *,
        candidate_limit: int = 350,
        timeout: float = 180.0,
    ) -> TrakeVisionOutcome:
        started = time.perf_counter()
        event_count = len(events)
        local = [dict(candidate) for candidate in candidates]
        if not events or not local:
            return TrakeVisionOutcome(
                [None] * event_count, [0.0] * event_count, False,
                "empty_candidates", (time.perf_counter() - started) * 1000,
            )
        video_ids = {str(candidate.get("video_id", "")) for candidate in local}
        if len(video_ids) != 1 or "" in video_ids:
            return TrakeVisionOutcome(
                [None] * event_count, [0.0] * event_count, False,
                "mixed_video_candidates", (time.perf_counter() - started) * 1000,
            )
        selected: List[Dict[str, Any]] = []
        selected_paths: List[Any] = []
        content: List[Dict[str, Any]] = [{
            "type": "text",
            "text": (
                "You are reading ONE continuous video timeline in ONE request. "
                "Candidate images are supplied in exact chronological order. "
                "Each text label applies to the single image immediately after "
                "it. The number beginning with # is the GLOBAL candidate_index. "
                "Larger candidate_index always means later video time. The tile "
                "marked ANCHOR is the event-search origin near the center of the "
                "window. Earlier frames are context only and MUST NOT be selected; "
                "E1 may equal ANCHOR when already visible there. "
                "Identify the single ordered chain E1, E2, ... nearest this "
                "reference that satisfies all event descriptions. For each event "
                "choose its temporal onset: compare adjacent candidates and pick "
                "the FIRST sampled frame where every required visible condition "
                "becomes true, not a later prettier confirmation. Event i must "
                "have a strictly larger candidate_index than event i-1. Inspect "
                "ALL candidate images before answering. Never invent an index or combine "
                "evidence from separate tiles. Before answering, verify that "
                "every output index is valid and that i1 < i2 < ... < iN. "
                "Return JSON only as "
                '{"event_candidates":[{"event_index":0,'
                '"candidate_indices":[i1,i2],"confidence":0.0}]}. '
                "For every event return the onset of each distinct matching "
                "occurrence (maximum 5), best semantic occurrence first. Do not "
                "pad the list with adjacent frames from the same occurrence. "
                "Before returning, verify that at least one "
                "strictly increasing E1..En chain can be formed from the lists. "
                "Include exactly one event_candidates "
                f"object for each of the {event_count} events. The server will "
                "choose the best strictly increasing chain from these alternatives. "
                f"Anchor: {str(anchor_query or '').strip() or '(none)'}\n"
                "Events:\n"
                + "\n".join(
                    f"E{index + 1}: {str(event).strip()}\n"
                    + self._trake_event_requirements(str(event))
                    for index, event in enumerate(events)
                )
            ),
        }]
        for candidate in local[: max(1, int(candidate_limit))]:
            try:
                video_id = str(candidate["video_id"])
                frame_id = int(candidate["frame_id"])
                path = candidate.get("_frame_path") or candidate.get("frame_path")
                if path is None:
                    path = self.frame_resolver(video_id, frame_id)
                if path is None:
                    continue
            except Exception as exc:
                logger.debug("Skip unavailable TRAKE Vision frame {}: {}", candidate, exc)
                continue
            row = dict(candidate)
            row["video_id"] = video_id
            row["frame_id"] = frame_id
            selected.append(row)
            selected_paths.append(path)
        if len(selected) < 2:
            return TrakeVisionOutcome(
                [None] * event_count, [0.0] * event_count, False,
                "insufficient_images", (time.perf_counter() - started) * 1000,
            )
        for index, (row, path) in enumerate(zip(selected, selected_paths)):
            marker = " ANCHOR" if row.get("_anchor_reference") else ""
            boundary = " BOUNDARY" if row.get("_shot_boundary") else ""
            try:
                with Image.open(path) as image:
                    frame_url = self._image_data_url(image, max_size=512)
            except Exception as exc:
                logger.warning(
                    "Cannot encode TRAKE timeline candidate #{}: {}", index, exc
                )
                return TrakeVisionOutcome(
                    [None] * event_count,
                    [0.0] * event_count,
                    False,
                    "timeline_frame_failed",
                    (time.perf_counter() - started) * 1000,
                )
            content.append({
                "type": "text",
                "text": (
                    f"TIMELINE #{index}; frame_id={int(row['frame_id'])}; "
                    f"timestamp={float(row.get('timestamp_seconds', 0.0)):.1f}s"
                    f"{marker}{boundary}. The next image is exactly this candidate."
                ),
            })
            content.append({
                "type": "image_url",
                "image_url": {"url": frame_url, "detail": "low"},
            })
        payload = {
            "model": self.model,
            "messages": [{"role": "user", "content": content}],
            "response_format": {"type": "json_object"},
            "thinking": {"type": "disabled"},
            "temperature": 0,
            "top_p": 1,
            "max_tokens": 900,
        }
        frame_ids: List[Optional[int]] = [None] * event_count
        confidences = [0.0] * event_count
        selection_repaired = False
        try:
            parsed = self._parse_json_content(self._post_json(payload, timeout))
            ordered_indices = None
            ordered_confidences = None
            raw_event_candidates = parsed.get("event_candidates")
            if isinstance(raw_event_candidates, list):
                anchor_index = next(
                    (
                        index
                        for index, candidate in enumerate(selected)
                        if candidate.get("_anchor_reference")
                    ),
                    len(selected) // 2,
                )
                options_by_event: Dict[int, List[int]] = {}
                confidence_by_event: Dict[int, float] = {}
                for candidate_row in raw_event_candidates:
                    if not isinstance(candidate_row, Mapping):
                        continue
                    try:
                        event_index = int(candidate_row.get("event_index"))
                    except (TypeError, ValueError):
                        continue
                    raw_options = candidate_row.get("candidate_indices")
                    if not 0 <= event_index < event_count or not isinstance(
                        raw_options, list
                    ):
                        continue
                    options = []
                    for raw_option in raw_options[:5]:
                        try:
                            option = int(raw_option)
                        except (TypeError, ValueError):
                            continue
                        if (
                            anchor_index <= option < len(selected)
                            and option not in options
                        ):
                            options.append(option)
                    if event_index == 0 and not options:
                        options = [anchor_index]
                    if not options:
                        continue
                    options_by_event[event_index] = options
                    try:
                        confidence_by_event[event_index] = max(
                            0.0,
                            min(1.0, float(candidate_row.get("confidence", 1.0))),
                        )
                    except (TypeError, ValueError):
                        confidence_by_event[event_index] = 1.0
                if len(options_by_event) == event_count:
                    # State: last candidate -> (semantic-rank cost, path).
                    states: Dict[int, tuple[float, List[int]]] = {
                        -1: (0.0, [])
                    }
                    for event_index in range(event_count):
                        next_states: Dict[int, tuple[float, List[int]]] = {}
                        for option_rank, option in enumerate(
                            options_by_event[event_index]
                        ):
                            viable = [
                                (cost, path)
                                for previous, (cost, path) in states.items()
                                if previous < option
                            ]
                            if not viable:
                                continue
                            previous_cost, previous_path = min(
                                viable,
                                key=lambda state: (
                                    state[0],
                                    (state[1][-1] - state[1][0])
                                    if len(state[1]) > 1 else 0,
                                    state[1],
                                ),
                            )
                            cost = previous_cost + option_rank * 100.0
                            if event_index == 0:
                                cost += abs(option - anchor_index) * 0.01
                            path = previous_path + [option]
                            current = next_states.get(option)
                            if current is None or (cost, path) < current:
                                next_states[option] = (cost, path)
                        states = next_states
                        if not states:
                            break
                    if states:
                        _last, (_cost, best_path) = min(
                            states.items(),
                            key=lambda state: (
                                state[1][0],
                                state[1][1][-1] - state[1][1][0],
                                abs(state[1][1][0] - anchor_index),
                                state[1][1],
                            ),
                        )
                        ordered_indices = best_path
                        ordered_confidences = [
                            confidence_by_event[index]
                            for index in range(event_count)
                        ]
                    else:
                        logger.warning(
                            "DeepSeek Vision TRAKE alternatives contain no "
                            "increasing chain: response={}",
                            parsed,
                        )
                        # The model occasionally recognizes all consecutive
                        # moments but swaps the labels of two visually similar
                        # actions. Reorder the detected occurrence clusters by
                        # time instead of issuing a second Vision request.
                        cluster_centers = sorted(
                            options[len(options) // 2]
                            for options in options_by_event.values()
                        )
                        if (
                            len(cluster_centers) == event_count
                            and all(
                                left < right
                                for left, right in zip(
                                    cluster_centers, cluster_centers[1:]
                                )
                            )
                        ):
                            ordered_indices = cluster_centers
                            ordered_confidences = [
                                min(0.6, confidence_by_event[index])
                                for index in range(event_count)
                            ]
                            selection_repaired = True
            if ordered_indices is None:
                ordered_indices = parsed.get("ordered_candidate_indices")
                ordered_confidences = parsed.get("confidences")
            if isinstance(ordered_indices, list):
                if len(ordered_indices) != event_count:
                    raise ValueError("ordered index count does not match events")
                rows = [
                    {
                        "event_index": index,
                        "candidate_index": candidate_index,
                        "confidence": (
                            ordered_confidences[index]
                            if isinstance(ordered_confidences, list)
                            and index < len(ordered_confidences)
                            else 1.0
                        ),
                    }
                    for index, candidate_index in enumerate(ordered_indices)
                ]
            else:
                rows = parsed.get("selections")
                if not isinstance(rows, list):
                    rows = parsed.get("events")
            if not isinstance(rows, list):
                raise ValueError("response contains no selections list")
            by_event: Dict[int, tuple[Optional[int], float]] = {}
            for row in rows:
                if not isinstance(row, Mapping):
                    continue
                event_field = (
                    "event_index" if "event_index" in row else "event"
                )
                raw_event = row.get(event_field)
                event_label = event_field == "event"
                if isinstance(raw_event, str):
                    raw_event = raw_event.strip()
                    if raw_event.lower().startswith("e"):
                        raw_event = raw_event[1:]
                        event_label = True
                try:
                    parsed_event = int(raw_event)
                except (TypeError, ValueError):
                    continue
                # 'event_index' is zero-based by contract. A human/model
                # friendly 'event'/'E1' label is one-based; tolerate both
                # without ever accepting an out-of-range event.
                event_index = (
                    parsed_event - 1 if event_label and parsed_event > 0
                    else parsed_event
                )
                if event_index in by_event or not 0 <= event_index < event_count:
                    continue
                raw_candidate = row.get(
                    "candidate_index",
                    row.get("selected_index", row.get("frame_index")),
                )
                if raw_candidate is None:
                    raw_frame = row.get("selected_frame_id", row.get("frame_id"))
                    if raw_frame is None:
                        by_event[event_index] = (None, 0.0)
                        continue
                    try:
                        frame_value = int(raw_frame)
                    except (TypeError, ValueError):
                        continue
                    matching = [
                        index for index, candidate in enumerate(selected)
                        if int(candidate["frame_id"]) == frame_value
                    ]
                    if not matching:
                        continue
                    candidate_index = matching[0]
                else:
                    try:
                        candidate_index = int(raw_candidate)
                    except (TypeError, ValueError):
                        continue
                if not 0 <= candidate_index < len(selected):
                    continue
                try:
                    confidence = max(
                        0.0,
                        min(1.0, float(
                            row.get("confidence", row.get("score", 1.0))
                        )),
                    )
                except (TypeError, ValueError):
                    confidence = 1.0
                by_event[event_index] = (
                    int(selected[candidate_index]["frame_id"]), confidence
                )
            for event_index in range(event_count):
                if event_index in by_event:
                    frame_ids[event_index], confidences[event_index] = by_event[event_index]
            if any(frame_id is None for frame_id in frame_ids):
                return TrakeVisionOutcome(
                    frame_ids, confidences, False, "incomplete_selection",
                    (time.perf_counter() - started) * 1000,
                )
            previous = -1
            for frame_id in frame_ids:
                assert frame_id is not None
                if frame_id <= previous:
                    logger.warning(
                        "DeepSeek Vision TRAKE returned a non-increasing "
                        "one-pass chain: frames={} response={}",
                        frame_ids,
                        parsed,
                    )
                    return TrakeVisionOutcome(
                        frame_ids, confidences, False, "non_increasing_selection",
                        (time.perf_counter() - started) * 1000,
                    )
                previous = frame_id
            return TrakeVisionOutcome(
                frame_ids,
                confidences,
                True,
                "order_repaired" if selection_repaired else "applied",
                (time.perf_counter() - started) * 1000,
            )
        except Exception as exc:
            logger.warning("DeepSeek Vision TRAKE fallback: {}", exc)
            return TrakeVisionOutcome(
                frame_ids, confidences, False, f"fallback:{type(exc).__name__}",
                (time.perf_counter() - started) * 1000,
            )
    def rerank_trake_event(
        self,
        event: str,
        candidates: Sequence[Mapping[str, Any]],
        *,
        anchor_query: str = "",
        lower_frame_id: Optional[int] = None,
        upper_frame_id: Optional[int] = None,
        candidate_limit: int = 80,
        timeout: float = 180.0,
        is_first_event: bool = False,
    ) -> TrakeVisionOutcome:
        """Refine one event inside a short exact-frame neighborhood."""
        started = time.perf_counter()
        local = sorted(
            (dict(candidate) for candidate in candidates),
            key=lambda row: int(row.get("frame_id", 0)),
        )
        if not event or not local:
            return TrakeVisionOutcome(
                [None], [0.0], False, "empty_candidates",
                (time.perf_counter() - started) * 1000,
            )
        video_ids = {str(candidate.get("video_id", "")) for candidate in local}
        if len(video_ids) != 1 or "" in video_ids:
            return TrakeVisionOutcome(
                [None], [0.0], False, "mixed_video_candidates",
                (time.perf_counter() - started) * 1000,
            )
        anchor_text = str(anchor_query or "").casefold()
        opening_context = any(
            marker in anchor_text
            for marker in (
                "đoạn video bắt đầu",
                "bắt đầu bằng",
                "mở đầu",
                "video starts",
                "opening shot",
                "begins with",
            )
        )
        if is_first_event and opening_context:
            anchor_rule = (
                "This is E1 and the anchor context explicitly describes the "
                "opening of this segment. Test ANCHOR_START before every later "
                "frame. If the named objects or the described scene are already "
                "visible at ANCHOR_START and the event asks for the first "
                "appearance/onset, select ANCHOR_START even when a still image "
                "cannot prove motion. For appearance or count events, small "
                "objects in the background, on a stage, or on a backdrop count "
                "when they are visibly present; do not require a close-up or a "
                "frozen motion pose. Do not return empty or wait for a later "
                "clearer frame merely because the action is dynamic."
            )
        elif is_first_event:
            anchor_rule = (
                "This is E1. ANCHOR_START is the temporal origin and is eligible "
                "when the event is already true there; do not wait for a later "
                "clearer frame."
            )
        else:
            anchor_rule = (
                "This is a later event. ANCHOR_START is only a lower temporal "
                "bound and must not be selected for this event."
            )
        requirements = self._trake_event_requirements(event)
        content: List[Dict[str, Any]] = [{
            "type": "text",
            "text": (
                "Temporal event verifier. These are existing extracted keyframes "
                "from one video in chronological order. Inspect EVERY candidate "
                "through the end of the list before answering; do not stop at the "
                "first vaguely related image. First apply the mandatory checklist "
                "to each candidate, then compare the first positive candidate with "
                "its immediate predecessor. "
                + anchor_rule
                + " Select the FIRST eligible sampled frame where every checklist "
                "item is visibly true. For a movement, landing, or contact event, "
                "select the first frame showing the required final state, not a "
                "later stable or clearer frame. If the event is already true at "
                "the lower bound, select that lower-bound frame. Rows marked "
                "SHOT_BOUNDARY_NEAR are early evidence only when they satisfy the "
                "whole checklist. Do not invent a frame id. Return JSON only as "
                '{"selections":[{"candidate_index":0,"confidence":0.0}],'
                '"checks":[{"candidate_index":0,"match":false}]}. '
                "Include one check for every eligible candidate. A check is true "
                "only when ALL checklist items are satisfied; use false for a "
                "partial match or an ineligible predecessor. If no candidate "
                "shows the event, return selections=[] and all checks false.\n"
                + requirements + "\n"
                f"Anchor context: {str(anchor_query or '').strip() or '(none)'}; "
                f"lower_bound_frame={lower_frame_id if lower_frame_id is not None else '(none)'}; "
                f"upper_bound_frame={upper_frame_id if upper_frame_id is not None else '(none)'}\n"
                f"Event: {str(event).strip()}"
            ),
        }]
        selected: List[Dict[str, Any]] = []
        selected_paths: List[Any] = []
        selected_focus_urls: List[Optional[str]] = []
        for candidate in local[: max(1, int(candidate_limit))]:
            try:
                video_id = str(candidate["video_id"])
                frame_id = int(candidate["frame_id"])
                path = candidate.get("_frame_path") or candidate.get("frame_path")
                if path is None:
                    path = self.frame_resolver(video_id, frame_id)
                if path is None:
                    continue
                with Image.open(path):
                    pass
            except Exception as exc:
                logger.debug(
                    "Skip unavailable TRAKE event frame {}: {}",
                    candidate,
                    exc,
                )
                continue
            index = len(selected)
            row = dict(candidate)
            row["video_id"] = video_id
            row["frame_id"] = frame_id
            selected.append(row)
            selected_paths.append(path)
            selected_focus_urls.append(
                self._event_focus_data_url(path, event)
            )
            timestamp = row.get("timestamp_seconds", 0.0)
            marker = ""
            if row.get("_anchor_start"):
                marker = "; ANCHOR_START"
            if row.get("_shot_boundary"):
                marker += "; SHOT_BOUNDARY_NEAR"
            content.append({
                "type": "text",
                "text": (
                    f"candidate_index={index}; video_id={row['video_id']}; "
                    f"frame_id={row['frame_id']}; timestamp_seconds={float(timestamp):.3f}"
                    f"{marker}"
                ),
            })
        if len(selected) < 2:
            return TrakeVisionOutcome(
                [None], [0.0], False, "insufficient_images",
                (time.perf_counter() - started) * 1000,
            )
        for index, (path, focus_url) in enumerate(
            zip(selected_paths, selected_focus_urls)
        ):
            content.append({
                "type": "image_url",
                "image_url": {"url": self._data_url(path), "detail": "high"},
            })
            if focus_url is not None:
                content.append({
                    "type": "text",
                    "text": (
                        f"candidate_index={index}; enlarged action crop "
                        "for the same exact frame"
                    ),
                })
                content.append({
                    "type": "image_url",
                    "image_url": {"url": focus_url, "detail": "high"},
                })
        payload = {
            "model": self.model,
            "messages": [{"role": "user", "content": content}],
            "response_format": {"type": "json_object"},
            "thinking": {"type": "disabled"},
            "temperature": 0,
            "top_p": 1,
            "max_tokens": 300,
        }
        try:
            parsed = self._parse_json_content(self._post_json(payload, timeout))
            rows = parsed.get("selections")
            if not isinstance(rows, list):
                rows = parsed.get("events")
            if not isinstance(rows, list):
                if any(
                    key in parsed
                    for key in ("candidate_index", "selected_index", "frame_index")
                ):
                    rows = [parsed]
            checks = parsed.get("checks", parsed.get("candidate_checks"))
            if isinstance(checks, list):
                positive = []
                for check in checks:
                    if not isinstance(check, Mapping):
                        continue
                    raw_match = check.get("match", check.get("meets_event"))
                    is_positive = raw_match is True or (
                        isinstance(raw_match, str)
                        and raw_match.strip().casefold() in {"true", "yes", "1"}
                    )
                    if not is_positive:
                        continue
                    try:
                        positive.append(int(check["candidate_index"]))
                    except (KeyError, TypeError, ValueError):
                        continue
                if positive:
                    first_positive = min(positive)
                    matching_rows = [
                        row for row in (rows if isinstance(rows, list) else [])
                        if isinstance(row, Mapping)
                        and row.get("candidate_index") is not None
                        and int(row.get("candidate_index", -1)) == first_positive
                    ]
                    rows = matching_rows or [{
                        "candidate_index": first_positive,
                        "confidence": 1.0,
                    }]
                else:
                    # A complete negative checklist must override a stale or
                    # malformed convenience selection.
                    rows = []
            if not isinstance(rows, list) or not rows:
                raise ValueError("response contains no event selection")
            row = next((item for item in rows if isinstance(item, Mapping)), None)
            if row is None:
                raise ValueError("response event selection is not an object")
            raw_candidate = row.get(
                "candidate_index",
                row.get("selected_index", row.get("frame_index")),
            )
            if raw_candidate is not None:
                candidate_index = int(raw_candidate)
                if not 0 <= candidate_index < len(selected):
                    raise ValueError("selected candidate index is out of range")
                frame_id = int(selected[candidate_index]["frame_id"])
            else:
                raw_frame = row.get(
                    "selected_frame_id",
                    row.get("frame_id", row.get("frame")),
                )
                if isinstance(raw_frame, str):
                    match = re.search(
                        r"\bframe(?:_id)?\s*[:=|]?\s*(\d+)\b",
                        raw_frame,
                        re.IGNORECASE,
                    )
                    if match:
                        raw_frame = match.group(1)
                frame_id = int(raw_frame)
                matching = [
                    item for item in selected
                    if int(item["frame_id"]) == frame_id
                ]
                if not matching:
                    raise ValueError("selected frame id is not in candidates")
            if lower_frame_id is not None and frame_id < int(lower_frame_id):
                raise ValueError("selected frame is before lower bound")
            if upper_frame_id is not None and frame_id > int(upper_frame_id):
                raise ValueError("selected frame is after upper bound")
            try:
                confidence = max(
                    0.0,
                    min(1.0, float(row.get("confidence", row.get("score", 1.0)))),
                )
            except (TypeError, ValueError):
                confidence = 1.0
            return TrakeVisionOutcome(
                [frame_id], [confidence], True, "refined",
                (time.perf_counter() - started) * 1000,
            )
        except Exception as exc:
            logger.warning("DeepSeek Vision TRAKE event refinement: {}", exc)
            return TrakeVisionOutcome(
                [None], [0.0], False, f"fallback:{type(exc).__name__}",
                (time.perf_counter() - started) * 1000,
            )


    def rerank(self, query: str, candidates: List[Dict[str, Any]], *,
               candidate_limit: int, timeout: float) -> VisionRerankOutcome:
        started = time.perf_counter()
        normalized_query = " ".join(query.lower().split())
        temporal = any(marker in normalized_query for marker in (
            "sau đó", "tiếp theo", "tiếp đến", "trước đó", "rồi",
            "then", "afterwards", "followed by", "before",
        ))
        selected: List[Dict[str, Any]] = []
        content: List[Dict[str, Any]] = [{
            "type": "text",
            "text": (
                "You are a strict video retrieval critic. Use only visible evidence; "
                "never invent a detail. Treat every explicit query detail as mandatory. "
                "A partial match must rank below a frame or chain satisfying all details. "
                + (
                    "This is a TEMPORAL query. Evaluate frames from the same video as an "
                    "ordered chain by increasing frame_id. Never combine evidence across "
                    "videos. Require all stated stages in the correct order, and let the "
                    "weakest or missing stage control the ranking. Rank first the frame "
                    "belonging to the best complete chain that answers the requested moment. "
                    if temporal else
                    "For non-temporal queries, rank frames by complete simultaneous visual "
                    "agreement, including count, color, layout, spatial relations and action. "
                )
                + "Return strict JSON only as {\"ranked_indices\":[0,1,...]}. "
                + "Return at most the 50 best candidate indices, best first. "
                + f"The input contains up to {candidate_limit} candidates; output only the strongest "
                + "50 when possible. Query: "
                + query
            ),
        }]
        input_candidates = list(candidates[:candidate_limit])
        if temporal:
            input_candidates.sort(
                key=lambda row: (
                    str(row.get("video_id", "")), int(row.get("frame_id", 0))
                )
            )
        for candidate in input_candidates:
            try:
                path = self.frame_resolver(
                    candidate["video_id"], int(candidate["frame_id"])
                )
                if path is None:
                    continue
                data_url = self._data_url(path)
            except Exception as exc:  # noqa: BLE001
                logger.debug("Skip unavailable DeepSeek frame {}: {}", candidate, exc)
                continue
            index = len(selected)
            selected.append(candidate)
            breakdown = candidate.get("fusion_breakdown") or {}
            manifest = (
                f"candidate_index={index}; video_id={candidate['video_id']}; "
                f"frame_id={int(candidate['frame_id'])}"
            )
            if breakdown.get("deepseek_temporal_chain"):
                manifest += (
                    f"; chain_id={int(breakdown['deepseek_temporal_chain'])}; "
                    f"chain_order={int(breakdown.get('deepseek_temporal_order', 0))}"
                )
            content.append({"type": "text", "text": manifest})
            content.append({
                "type": "image_url",
                "image_url": {"url": data_url, "detail": "low"},
            })
        if len(selected) < 2:
            return VisionRerankOutcome(candidates, False, "insufficient_images",
                                       (time.perf_counter() - started) * 1000)

        payload = json.dumps({
            "model": self.model,
            "messages": [{"role": "user", "content": content}],
            "response_format": {"type": "json_object"},
            "thinking": {"type": "disabled"},
            "temperature": 0,
            "top_p": 1,
            "max_tokens": 1200,
        }).encode("utf-8")
        req = request.Request(
            self.base_url + "/chat/completions", data=payload, method="POST",
            headers={"Authorization": f"Bearer {self.api_key}",
                     "Content-Type": "application/json"},
        )
        try:
            with request.urlopen(req, timeout=timeout) as response:
                envelope = json.loads(response.read().decode("utf-8"))
            raw = envelope["choices"][0]["message"]["content"]
            parsed = json.loads(raw)
            assessed = parsed.get("ranked_indices", [])
            if not assessed:
                # DeepSeek occasionally uses an equivalent wrapper despite
                # response_format=json_object. Accept only explicit ranking
                # keys; never scrape arbitrary numbers from its explanation.
                for key in ("ranking", "indices", "ranked_candidates", "candidates"):
                    value = parsed.get(key)
                    if isinstance(value, list):
                        assessed = value
                        break
            valid = []
            seen = set()
            for value in assessed:
                if isinstance(value, dict):
                    raw_idx = value.get(
                        "index", value.get("candidate_index", value.get("id", -1))
                    )
                else:
                    raw_idx = value
                idx = int(raw_idx)
                if 0 <= idx < len(selected) and idx not in seen:
                    valid.append(idx)
                    seen.add(idx)
            if not valid:
                logger.warning("DeepSeek invalid ranking payload: {}", raw[:800])
                raise ValueError("response contains no valid ranked_indices")
            ranked = []
            for vision_rank, idx in enumerate(valid, start=1):
                row = dict(selected[idx])
                row["deepseek_vision_rank"] = vision_rank
                ranked.append(row)
            selected_keys = {(r["video_id"], int(r["frame_id"])) for r in ranked}
            ranked.extend(
                dict(row) for row in candidates
                if (row["video_id"], int(row["frame_id"])) not in selected_keys
            )
            return VisionRerankOutcome(ranked, True, "applied",
                                       (time.perf_counter() - started) * 1000)
        except Exception as exc:  # noqa: BLE001
            logger.warning("DeepSeek Vision fallback: {}", exc)
            return VisionRerankOutcome(candidates, False, f"fallback:{type(exc).__name__}",
                                       (time.perf_counter() - started) * 1000)
