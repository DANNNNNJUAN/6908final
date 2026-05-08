# InkSight Local Deployment Project Structure

## PPT-ready SVG

Use this file directly in slides:

- `docs/project-structure-local-deploy.svg`

![InkSight Local Deployment Architecture](project-structure-local-deploy.svg)

## Editable Mermaid Version

```mermaid
flowchart LR
    User["User / Presenter"]

    subgraph Local["Local Deployment Environment"]
        Frontend["Frontend: Next.js WebApp<br/>webapp/<br/>configuration, preview UI, mode selection"]
        Backend["Backend: FastAPI<br/>backend/<br/>API, config storage, rendering pipeline"]
        DB["SQLite Storage<br/>inksight.db / cache.db<br/>device config, render cache, history"]
        Modes["JSON Mode System<br/>backend/core/modes/<br/>built-in and custom modes"]
        Renderer["E-ink Renderer<br/>pipeline.py + json_renderer.py<br/>content to bitmap image"]
    end

    subgraph AI["AI Content Generation"]
        DeepSeek["DeepSeek API<br/>OpenAI-compatible interface<br/>briefing, poetry, suggestions, AI content"]
    end

    subgraph Device["Hardware Device"]
        Firmware["ESP32-C3 Firmware<br/>firmware/src/<br/>Wi-Fi, HTTP fetch, sleep, refresh control"]
        EInk["4.2-inch E-ink Display<br/>low-power paper-like output"]
    end

    User -->|"configure locally"| Frontend
    Frontend -->|"REST API requests"| Backend
    Backend -->|"read / write"| DB
    Backend -->|"load mode definitions"| Modes
    Backend -->|"call model when needed"| DeepSeek
    Modes --> Renderer
    DeepSeek --> Renderer
    Backend --> Renderer
    Renderer -->|"PNG preview"| Frontend
    Firmware -->|"LAN request: /api/render"| Backend
    Backend -->|"BMP image response"| Firmware
    Firmware -->|"refresh screen"| EInk
```

## Short Talk Track

InkSight is deployed as a local end-to-end system. The Next.js frontend and FastAPI backend both run on the local machine. The frontend is used for configuration and preview, while the backend owns device configuration, mode loading, AI content generation, caching, and e-ink image rendering.

DeepSeek is integrated through an OpenAI-compatible API and is called by the backend only when a mode needs AI-generated content. The ESP32-C3 firmware stays lightweight: it connects to Wi-Fi, requests the rendered bitmap from the local backend over LAN, and refreshes the e-ink display.
