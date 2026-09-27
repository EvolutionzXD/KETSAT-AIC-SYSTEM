"""Hybrid rank/score/consensus fusion helpers for KIS."""
from __future__ import annotations

import re
from dataclasses import replace
from typing import Callable, Dict, List, Mapping, Sequence, Tuple


_TOPIC_RE = re.compile(r"^(L\d+)(?:_V|_)", re.IGNORECASE)


def document_id(signal) -> str:
    return f"{signal.video_id}:{int(signal.frame_id)}"


def video_topic_group(video_id: str) -> str:
    """Return the coarse collection/topic prefix (for example ``L21``)."""
    match = _TOPIC_RE.match(str(video_id))
    return match.group(1).upper() if match else str(video_id).split("_", 1)[0]


def align_visual_rankers_to_windows(
    rankers: Mapping[str, Sequence],
    *,
    fps_lookup: Callable[[str], float],
    window_seconds: float,
) -> Dict[str, List]:
    """Canonicalize nearby visual hits before cross-model fusion.

    Different encoders commonly select adjacent keyframes from the same
    event. Exact-id RRF treats those as disagreement. This groups hits within
    a bounded, non-transitive time window and retargets them to one real frame.
    Duplicate votes from the same model/window are collapsed to its best rank.
    """
    if window_seconds <= 0:
        return {name: list(signals) for name, signals in rankers.items()}

    pooled: Dict[str, List[Tuple[str, object]]] = {}
    for ranker, signals in rankers.items():
        for signal in signals:
            if signal.video_id:
                pooled.setdefault(str(signal.video_id), []).append((ranker, signal))

    canonical: Dict[Tuple[str, str, int], int] = {}
    for video_id, entries in pooled.items():
        entries.sort(key=lambda item: (int(item[1].frame_id), item[0], int(item[1].rank)))
        fps = max(1e-6, float(fps_lookup(video_id)))
        window_frames = max(1, int(round(window_seconds * fps)))
        clusters: List[List[Tuple[str, object]]] = []
        current: List[Tuple[str, object]] = []
        anchor = 0
        for item in entries:
            frame = int(item[1].frame_id)
            if not current or frame - anchor <= window_frames:
                if not current:
                    anchor = frame
                current.append(item)
            else:
                clusters.append(current)
                current = [item]
                anchor = frame
        if current:
            clusters.append(current)

        for cluster in clusters:
            # Prefer the strongest within-ranker position; tie-break by frame.
            representative = min(cluster, key=lambda item: (int(item[1].rank), int(item[1].frame_id)))[1]
            representative_frame = int(representative.frame_id)
            for ranker, signal in cluster:
                canonical[(ranker, video_id, int(signal.frame_id))] = representative_frame

    output: Dict[str, List] = {}
    for ranker, signals in rankers.items():
        best_by_doc = {}
        for signal in signals:
            frame = canonical.get(
                (ranker, str(signal.video_id), int(signal.frame_id)),
                int(signal.frame_id),
            )
            aligned = replace(signal, frame_id=frame)
            doc_id = document_id(aligned)
            current = best_by_doc.get(doc_id)
            if current is None or (int(aligned.rank), -float(aligned.score)) < (
                int(current.rank), -float(current.score)
            ):
                best_by_doc[doc_id] = aligned
        ordered = sorted(best_by_doc.values(), key=lambda s: (int(s.rank), -float(s.score), document_id(s)))
        output[ranker] = [replace(signal, rank=rank) for rank, signal in enumerate(ordered, 1)]
    return output


def _linear_confidence(score: float, floor: float, ceiling: float) -> float:
    if score < floor:
        return 0.0
    if ceiling <= floor:
        return 1.0
    return max(0.0, min(1.0, (float(score) - floor) / (ceiling - floor)))


def signal_confidence(signal, settings) -> float:
    name = str(signal.name)
    # The regional lane's public score is its internal axis-RRF value, not a
    # calibrated cosine.  It should contribute through its own outer RRF
    # rank only; treating 0.02-0.03 as a cosine would make the confidence
    # bonus depend on an unrelated score scale.
    if name == "visual_spatial_beit3":
        return 0.0
    ranges = {
        "visual_pe_core": (settings.pe_core_score_threshold, settings.pe_core_score_ceiling),
        "visual_beit3": (settings.beit3_score_threshold, settings.beit3_score_ceiling),
        "visual_siglip2": (settings.siglip2_score_threshold, settings.siglip2_score_ceiling),
        "visual": (0.0, 1.0),
        "audio": (settings.audio_confidence_floor, settings.audio_confidence_ceiling),
        "ocr": (settings.ocr_confidence_floor, settings.ocr_confidence_ceiling),
        "ocr_semantic": (0.0, 1.0),
        "caption": (settings.caption_confidence_floor, settings.caption_confidence_ceiling),
    }
    floor, ceiling = ranges.get(name, (0.0, 1.0))
    return _linear_confidence(float(signal.score), float(floor), float(ceiling))


def apply_hybrid_bonuses(
    base_scores: Mapping[str, float],
    rankers: Mapping[str, Sequence],
    *,
    settings,
    rrf_k: int,
    specialist_intent: str = "default",
) -> Tuple[Dict[str, float], Dict[str, Dict[str, float]]]:
    """Add bounded confidence, agreement, specialist and topic bonuses."""
    scores = dict(base_scores)
    breakdown: Dict[str, Dict[str, float]] = {
        doc_id: {"rrf": float(score)} for doc_id, score in scores.items()
    }
    evidence: Dict[str, Dict[str, object]] = {}
    for ranker_name, signals in rankers.items():
        for signal in signals:
            if (
                ranker_name == "caption"
                and settings.caption_rank_cutoff is not None
                and int(signal.rank) > int(settings.caption_rank_cutoff)
            ):
                continue
            doc_id = document_id(signal)
            item = evidence.setdefault(
                doc_id,
                {"rankers": set(), "visual": set(), "families": set(), "confidence": {}},
            )
            item["rankers"].add(ranker_name)
            if ranker_name in ("ocr", "ocr_semantic"):
                family = "ocr"
            else:
                family = "visual" if ranker_name.startswith("visual_") else ranker_name
            item["families"].add(family)
            if ranker_name.startswith("visual_"):
                # Spatial crop and full-frame BEiT-3 share one encoder.
                # They are separate ranked lists for retrieval, but not
                # independent visual evidence for the consensus bonus.
                visual_family = (
                    "visual_beit3"
                    if ranker_name == "visual_spatial_beit3"
                    else ranker_name
                )
                item["visual"].add(visual_family)
            confidence = signal_confidence(signal, settings)
            item["confidence"][ranker_name] = max(
                confidence, item["confidence"].get(ranker_name, 0.0)
            )

    for doc_id, item in evidence.items():
        if doc_id not in scores:
            continue
        confidence_bonus = settings.fusion_confidence_bonus * sum(item["confidence"].values())
        visual_bonus = settings.fusion_visual_consensus_bonus * max(0, len(item["visual"]) - 1)
        multimodal_bonus = settings.fusion_multimodal_consensus_bonus * max(0, len(item["families"]) - 1)
        specialist_bonus = 0.0
        eligible_specialists = {"caption"}
        if specialist_intent == "asr":
            eligible_specialists.add("audio")
        elif specialist_intent == "ocr":
            eligible_specialists.update(("ocr", "ocr_semantic"))
        for specialist in eligible_specialists:
            confidence = item["confidence"].get(specialist, 0.0)
            if confidence >= settings.fusion_specialist_confidence_gate:
                specialist_bonus += settings.fusion_specialist_bonus * confidence
        scores[doc_id] += confidence_bonus + visual_bonus + multimodal_bonus + specialist_bonus
        breakdown.setdefault(doc_id, {}).update(
            confidence=confidence_bonus,
            visual_consensus=visual_bonus,
            multimodal_consensus=multimodal_bonus,
            specialist=specialist_bonus,
        )

    # Coarse topic prior: use only cross-ranker agreement in their heads.
    topic_support: Dict[str, Dict[str, float]] = {}
    head = int(settings.fusion_topic_rank_head)
    for ranker_name, signals in rankers.items():
        best_for_topic: Dict[str, int] = {}
        for signal in signals:
            if int(signal.rank) > head:
                continue
            if (
                ranker_name == "caption"
                and settings.caption_rank_cutoff is not None
                and int(signal.rank) > int(settings.caption_rank_cutoff)
            ):
                continue
            topic = video_topic_group(signal.video_id)
            best_for_topic[topic] = min(best_for_topic.get(topic, int(signal.rank)), int(signal.rank))
        for topic, rank in best_for_topic.items():
            topic_support.setdefault(topic, {})[ranker_name] = 1.0 / (rrf_k + rank)
    max_affinity = max((sum(v.values()) for v in topic_support.values()), default=0.0)
    if max_affinity > 0:
        for doc_id in list(scores):
            video_id = doc_id.rsplit(":", 1)[0]
            support = topic_support.get(video_topic_group(video_id), {})
            if len(support) < 2:
                continue
            affinity = sum(support.values()) / max_affinity
            consensus = min(1.0, (len(support) - 1) / 2.0)
            bonus = settings.fusion_topic_group_bonus * affinity * consensus
            scores[doc_id] += bonus
            breakdown.setdefault(doc_id, {})["topic_group"] = bonus
    return scores, breakdown


__all__ = [
    "align_visual_rankers_to_windows",
    "apply_hybrid_bonuses",
    "document_id",
    "signal_confidence",
    "video_topic_group",
]
