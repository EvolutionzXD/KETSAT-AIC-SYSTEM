<div align="center">

# ⚡ T-S-T AIC SYSTEM ⚡
### *High-Performance Multi-Modal Interactive Video Retrieval Engine*

[![Python](https://img.shields.io/badge/Python-3.10%2B-blue?style=for-the-badge&logo=python&logoColor=white)](https://python.org)
[![FastAPI](https://img.shields.io/badge/FastAPI-0.100%2B-009688?style=for-the-badge&logo=fastapi&logoColor=white)](https://fastapi.tiangolo.com)
[![Qdrant](https://img.shields.io/badge/Qdrant-Vector%20DB-DC2626?style=for-the-badge&logo=qdrant&logoColor=white)](https://qdrant.tech)
[![Typesense](https://img.shields.io/badge/Typesense-Search-F43F5E?style=for-the-badge&logo=typesense&logoColor=white)](https://typesense.org)
[![Vite](https://img.shields.io/badge/Vite-Frontend-646CFF?style=for-the-badge&logo=vite&logoColor=white)](https://vitejs.dev)
[![Backblaze B2](https://img.shields.io/badge/Backblaze%20B2-Edge%20Storage-E11D48?style=for-the-badge&logo=backblaze&logoColor=white)](https://backblaze.com)
[![Docker](https://img.shields.io/badge/Docker-Ready-2496ED?style=for-the-badge&logo=docker&logoColor=white)](https://docker.com)

<p align="center">
  <b>Built for the Ho Chi Minh City AI Challenge (AIC 2026)</b><br>
  A production-grade, distributed video search and real-time retrieval platform engineered for ultra-fast candidate identification, temporal reasoning, and sub-second evaluation submission.
</p>

---

</div>

## 🌟 Key Highlights & Core Innovations

### ⚡ 1. Direct Edge Frame Streaming (Backblaze B2 + CDN)
- **Zero Backend Bottleneck**: 100% client-side parallel asset retrieval directly from B2 cloud storage via cached authorization tokens.
- **Smart 5-Grid Snapping**: Automatically snaps target timestamps to exact physical candidate keyframes (`Math.round(f / 5) * 5`) with candidate `r.frame_path` direct routing.
- **Dynamic Bandwidth Management**: Video boundary prefetching is intelligently toggled off during interactive bursts to prioritize instant image rendering.

### 🧠 2. Deep Multi-Modal Hybrid Search Pipeline
- **Visual Encoders**: Ensembled embeddings leveraging **SigLIP-2**, **BEiT-3**, **PE-Core**, and **Jina-CLIP v5**.
- **Lexical & Semantic Fusion**: Real-time cross-modal reranking combining visual dense vectors (Qdrant), ASR transcripts, OCR text, and dense captions via **Reciprocal Rank Fusion (RRF)**.
- **Auto Cross-Lingual Translation**: Automatic Vietnamese-to-English query translation (`translate=true`) with manual override (`Alt+E`).

### 🎯 3. Multi-Task Competition Ready
- **KIS (Known-Item Search)**: Multi-query temporal chaining with millisecond-exact frame pinpointing.
- **VQA (Video Question Answering)**: Visual-linguistic reasoning with integrated answer generation and context scoring.
- **TRAKE (Target Tracking & Action Sequence)**: Multi-frame sequence builder, interactive drag-and-drop reordering with insertion drop markers, snapshot undo (`↩ Undo`), and instant manual fallback modal (`Alt+M`).

### 👥 4. Real-time Team Collaboration & Deduplication
- **WebSocket Synchronization**: Real-time state broadcasting across operators (`/ws/team`, `/ws/dres`, `/ws/queue`, `/ws/trake`).
- **Collision & Duplicate Prevention**: In-memory and distributed lock tracking of submitted queries, warning team members before redundant submissions to DRES.

---

## 🏛️ System Architecture

```mermaid
flowchart TB
    subgraph Client["🖥️ Frontend Client (Vite + Vanilla JS)"]
        UI["Modern Web Interface"]
        VPlayer["Interactive Video Player & Frame Scrubber"]
        Cart["Submission Cart & TRAKE Trajectory Manager"]
        EdgeCache["B2 Direct Download & Token Cache"]
    end

    subgraph Edge["☁️ Cloudflare / Backblaze B2"]
        CDN["B2 Direct Bucket (aic2026-cli)"]
        Frames["Pre-extracted 5-Grid Keyframes"]
        Videos["Raw Video Streams (HLS / MP4)"]
    end

    subgraph Backend["⚡ Retrieval Engine (FastAPI)"]
        API["Search Router & WebSocket Hub"]
        RRF["Reciprocal Rank Fusion (RRF)"]
        Trans["Vietnamese-English Translation"]
        Dedupe["Team Deduplication Engine"]
    end

    subgraph Storage["🗄️ Hybrid Storage & Vector Databases"]
        Qdrant[("Qdrant Vector DB\n(SigLIP2, BEiT3, PE-Core, Jina)")]
        Typesense[("Typesense Search Engine\n(OCR, ASR, Captions)")]
        Catalog[("SQLite Metadata Catalog")]
    end

    subgraph DRES["🏆 Evaluation Server"]
        DresServer["Official AIC DRES Server"]
    end

    UI --> API
    EdgeCache <--> CDN
    CDN --> Frames & Videos
    API --> RRF
    RRF --> Qdrant & Typesense & Catalog
    Cart -->|Submit Frame / Sequence| DresServer
    API <-->|WebSocket Team Sync| UI
```

---

## 📂 Repository Structure

```plaintext
.
├── backend/                        # FastAPI Search Engine
│   ├── backend/
│   │   ├── app.py                  # Main application & routing entrypoint
│   │   ├── config.py               # Dynamic settings & environment loader
│   │   └── ...
│   ├── src/
│   │   ├── pipeline/               # Multi-modal fusion & search engine
│   │   ├── models/                 # Model adapters & inference wrappers
│   │   └── utils/                  # Text processing, B2 signers, RRF utils
│   ├── Dockerfile                  # Containerization specification
│   ├── requirements.txt            # Python dependencies
│   └── run_final_api.sh            # Production startup script
│
├── frontend/                       # Interactive Web Retrieval Interface
│   ├── index.html                  # Main SPA markup & responsive layout
│   ├── style.css                   # Custom modern dark-mode stylesheet
│   ├── app.js                      # Core frontend application & state machine
│   ├── server.py                   # Lightweight proxy / static server
│   ├── vite.config.js              # Vite bundler & dev server config
│   ├── src/
│   │   ├── scripts/                # Modular client utilities & WebSocket handlers
│   │   └── styles/                 # Granular component styles
│   └── public/                     # Static icons, vector assets & SVG sprites
│
└── README.md                       # Documentation & Operations Manual
```

---

## ⌨️ Power-User Shortcuts Cheatsheet

| Shortcut | Scope | Action |
| :--- | :--- | :--- |
| **`Enter`** | Query Input | Execute search query (Shift+Enter for newline) |
| **`Ctrl + Enter`** | Query Input | Best-frame refinement on selected video candidate |
| **`/`** | Global | Instantly focus the main query input |
| **`1` · `2` · `3`** | Global | Switch task mode: **KIS** · **VQA** · **TRAKE** |
| **`Alt + E`** | Global | Toggle automatic Vietnamese → English translation |
| **`Alt + W`** | Global | Toggle Grid view ↔ Grouped-by-video view |
| **`Alt + A`** | Global | Open / Close submission cart drawer |
| **`Alt + M`** | Global | Open General Manual Submission Modal |
| **`Ctrl + S`** | Global | Quick-submit top candidate to DRES |
| **`Space`** | Video Player | Play / Pause video playback |
| **`←` / `→`** | Video Player | Jump backward / forward by 5 seconds (1 frame with `◀ 1f` / `1f ▶`) |
| **`Hold Shift`** | Video / Hover | Turbo speed **x1.5** (reverts on release) |
| **`Hold Shift + Z`** | Video / Hover | Maximum speed boost **x2.0** |
| **`G`** | Video Player | Quick Jump: Type target frame index + Enter |
| **`C`** | Video Player | Add current frame to Submission Cart |
| **`S`** | Video Player | Directly submit current frame to DRES |
| **`1` – `4`** | Video Player | Set playback rate: 0.5x · 1.0x · 1.5x · 2.0x |

---

## 🚀 Quick Start Guide

### 1. Launch Backend Service

```bash
cd backend

# Setup environment
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt

# Run the search API server (Default: Port 8602)
bash run_final_api.sh
```

### 2. Launch Frontend Client

```bash
cd frontend

# Install Node dependencies
npm install

# Start Vite development server
npm run dev
```

Open your browser at `http://localhost:8084` to access the interactive search workspace.

---

## 🛡️ License & Acknowledgements

- Developed by the **T-S-T Team** for **Ho Chi Minh City AI Challenge (AIC 2026)**.
- Powered by open-source vision-language models and vector databases: [Qdrant](https://qdrant.tech), [Typesense](https://typesense.org), [HuggingFace](https://huggingface.co).
