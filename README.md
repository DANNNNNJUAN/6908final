# 6908 Final Project: InkSight Local AI E-Ink Companion

This repository contains our final-project version of **InkSight**, a local-first AI e-ink companion system built around:

- a **Next.js web app** for configuration, preview, and device management
- a **FastAPI backend** for rendering, mode orchestration, and AI content generation
- an **ESP32-C3 + e-ink device** that fetches rendered output over LAN
- an **interactive Pixel Cat screen chat flow** for lightweight on-device AI responses

Instead of treating the e-ink display as a passive dashboard, this version focuses on a more complete local workflow: configure the device in a browser, preview content, enable Focus Listening, and push AI-generated answers to the screen.

## What This Project Adds

Compared with the original upstream codebase, this project snapshot is centered on a local demo / course-project workflow:

- **Local end-to-end deployment** of frontend, backend, and device communication
- **Interactive `ask_screen.py` tool** for sending AI answers directly to the e-ink device
- **Pixel Cat companion mode** for short-lived on-screen conversational responses
- **English-facing README, docs, and UI cleanup** for easier presentation and review
- **Project-structure diagram and local deployment notes** for slides and demos

## Core Features

- **Device configuration in the browser**
  - pair devices
  - select modes
  - preview content before applying
  - manage sharing and device status
- **AI-backed rendering pipeline**
  - mode definitions in JSON
  - backend rendering to preview and device-ready images
  - optional LLM generation through provider APIs such as DeepSeek
- **Interactive screen messaging**
  - send a direct answer to the device
  - or let the backend call the model and render the answer
  - optionally decorate the response with Pixel Cat actions and outfits
- **Local LAN device flow**
  - the ESP32 firmware talks to the backend over the local network
  - no cloud deployment is required for the core demo

## Tech Stack

- **Frontend:** Next.js / React / TypeScript
- **Backend:** FastAPI / Python
- **Firmware:** ESP32-C3 / PlatformIO
- **Storage:** SQLite-based local config and cache
- **AI providers:** OpenAI-compatible APIs such as DeepSeek

## Project Structure

```text
backend/         FastAPI API, rendering pipeline, device endpoints, AI integration
webapp/          Next.js website, config UI, preview UI, device management
firmware/        ESP32 firmware for the e-ink hardware
docs/            local deployment notes, architecture docs, setup guides
backend/scripts/ ask_screen.py interactive CLI for screen Q&A
```

For the presentation-ready system diagram, see:

- [`docs/project-structure-local-deploy.md`](docs/project-structure-local-deploy.md)
- [`docs/project-structure-local-deploy.svg`](docs/project-structure-local-deploy.svg)

## Quick Start

### 1. Start the backend

```bash
cd backend
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python -m uvicorn api.index:app --host 0.0.0.0 --port 8080
```

On Windows PowerShell, use:

```powershell
cd backend
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
python -m uvicorn api.index:app --host 0.0.0.0 --port 8080
```

### 2. Start the web app

```bash
cd webapp
npm install
npm run dev
```

The main local entry points are:

- Web app: `http://127.0.0.1:3000`
- Backend: `http://127.0.0.1:8080`

### 3. Configure the device

Use the web app to:

1. pair or claim the device
2. open the device configuration page
3. enable **Focus Listening**
4. save the device setup

### 4. Run interactive screen chat

After the device is online and configured, use:

```bash
python backend/scripts/ask_screen.py <base_url> <mac> <alert_token> --interactive --provider deepseek --model deepseek-chat --api-key "<your_api_key>"
```

Example:

```bash
python backend/scripts/ask_screen.py http://127.0.0.1:8080 AC:EB:E6:8D:D4:F0 YOUR_ALERT_TOKEN --interactive --provider deepseek --model deepseek-chat --api-key "YOUR_REAL_KEY"
```

You can then type questions directly in the terminal and have the response rendered to the e-ink device.

## Pixel Cat Interaction Flow

The interactive screen mode works like this:

1. the CLI sends a question to the backend
2. the backend optionally calls the configured LLM
3. the backend packages the answer into the device ask/render flow
4. the e-ink screen shows the answer with a Pixel Cat companion for a short period
5. the device then returns to its previous normal content flow

This makes the hardware feel more like a small ambient AI terminal than a static status panel.

## Recommended Demo Flow

For a live demo or final presentation, the smoothest sequence is:

1. show the local architecture diagram
2. open the web app and display the config / preview workflow
3. show that the backend is running locally
4. send a prompt through `ask_screen.py`
5. let the device display the Pixel Cat answer on the e-ink screen

## Helpful Docs

- Local deployment overview: [`docs/deploy.md`](docs/deploy.md)
- Device configuration: [`docs/config.md`](docs/config.md)
- Hardware guide: [`docs/hardware.md`](docs/hardware.md)
- Assembly guide: [`docs/assembly.md`](docs/assembly.md)
- Flashing guide: [`docs/flash.md`](docs/flash.md)
- Restart-from-scratch notes: [`docs/restart-from-zero-zh.md`](docs/restart-from-zero-zh.md)

## Notes

- This repository is a **project snapshot**, not just a clean upstream mirror.
- Some files still reflect ongoing experimentation and local adaptation.
- The most distinctive custom addition for this final version is the **interactive local screen Q&A flow** built around `backend/scripts/ask_screen.py`.
