# InkSight Local Restart From Scratch

This document is meant for two common situations:

- you want to boot a fresh local InkSight environment on a new computer
- you already experimented once and now want a stable, repeatable way to bring the project back up

The examples below assume Windows + PowerShell, with the project located at:

```text
D:\6908\inksight
```

## 1. What you actually need to run

For day-to-day local debugging, you usually only need these three pieces:

1. `backend` for the local API, rendering, device communication, and Pixel Cat interaction
2. `webapp` for claiming devices and enabling Focus Listening
3. `firmware` on the microcontroller itself

If the device is already flashed, provisioned, and has Focus Listening enabled, then your normal setup is often just:

- `backend`
- the CLI interaction script `scripts/ask_screen.py`

That is enough for continuous conversations.

## 2. Prerequisites

Prepare the following first:

- Python 3.9+
- Node.js 20+
- npm
- PlatformIO CLI, only if you still need to flash firmware
- the device and your computer on the same LAN

## 3. First-time dependency setup

### 3.1 Install backend dependencies

```powershell
cd D:\6908\inksight\backend
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
```

### 3.2 Configure backend environment variables

Copy the sample environment file:

```powershell
cd D:\6908\inksight\backend
Copy-Item .env.example .env
```

At minimum, configure one working model key, for example:

```env
DEEPSEEK_API_KEY=your-real-DeepSeek-key
```

If you only want to test fixed text on the screen and do not need model calls yet, you can postpone this step.

### 3.3 Install webapp dependencies

```powershell
cd D:\6908\inksight\webapp
npm install
```

## 4. Start the local services

It is easiest to use two terminals.

### Terminal 1: start the backend

```powershell
cd D:\6908\inksight\backend
.\.venv\Scripts\Activate.ps1
python -m uvicorn api.index:app --host 0.0.0.0 --port 8080
```

The local backend address is:

- `http://127.0.0.1:8080`

### Terminal 2: start the webapp

```powershell
cd D:\6908\inksight\webapp
npm run dev
```

The local webapp address is usually:

- `http://127.0.0.1:3000`

## 5. Find your LAN IP

The device cannot reach your computer through `127.0.0.1`. It must use your LAN IP.

Run this in PowerShell:

```powershell
ipconfig
```

Find the IPv4 address for your current Wi-Fi adapter, for example:

```text
192.168.1.119
```

Your device `server_url` should then be:

```text
http://192.168.1.119:8080
```

## 6. Flash firmware for the first time, if needed

The default PlatformIO environment in this project is:

```text
epd_42_wsv2_ssd1683_c3_promini
```

Flash with:

```powershell
cd D:\6908\inksight\firmware
pio run -e epd_42_wsv2_ssd1683_c3_promini -t upload
```

Open the serial monitor:

```powershell
pio device monitor -b 115200
```

If you use a different board or screen, replace the environment name with the matching one from `firmware/platformio.ini`.

## 7. Enter the provisioning portal

If the device is not on Wi-Fi yet:

1. power the device off
2. hold the `BOOT` or config button
3. power the device back on
4. keep holding for 2 to 3 seconds, then release

The device should create a hotspot named something like:

```text
InkSight-xxxxx
```

Connect your phone or computer to that hotspot and open:

- `http://192.168.4.1`

## 8. What to fill in on the provisioning page

Enter:

1. `WiFi Name (SSID)`: your home or office Wi-Fi
2. `WiFi Password`: the matching password
3. `Server URL`:

```text
http://your-lan-ip:8080
```

For example:

```text
http://192.168.1.119:8080
```

4. the frontend port below that:

```text
3000
```

Then click:

- `Connect and Save`

## 9. Claim the device and enable Focus Listening

Once the device is online, open the local config page:

- [http://127.0.0.1:3000/config](http://127.0.0.1:3000/config)

Then:

1. register or sign in to a local account
2. claim the device using the pairing flow on the page
3. open the device configuration page
4. enable `Focus Listening`
5. note the device MAC address

Important:

- after enabling `Focus Listening`, restart the device once so it begins stable alert polling

## 10. Restart the device

The most reliable restart method is:

1. unplug USB power
2. wait 2 seconds
3. plug it back in

Or press one of the board reset buttons:

- `EN`
- `RST`
- `RESET`

## 11. Start the Pixel Cat interactive session

`ask_screen.py` supports interactive mode.

If you do not append a question directly to the command, it enters continuous chat mode:

```powershell
cd D:\6908\inksight\backend
.\.venv\Scripts\Activate.ps1
python scripts\ask_screen.py http://127.0.0.1:8080 YOUR_DEVICE_MAC anything --provider deepseek --model deepseek-chat --api-key "your-real-key"
```

Example:

```powershell
python scripts\ask_screen.py http://127.0.0.1:8080 AC:EB:E6:8D:D4:F0 anything --provider deepseek --model deepseek-chat --api-key "your-real-key"
```

You should then see:

```text
InkSight Pixel Cat chat started.
Device: AC:EB:E6:8D:D4:F0
Type your question and press Enter.
Commands: /help  /answer <text>  /quit
you>
```

You can now keep asking questions:

```text
you> Plan a relaxed two-day trip to Hangzhou for me.
you> Explain what a black hole is in one sentence.
you> I feel anxious today. Can you comfort me a little?
```

Common commands:

- `/help`
- `/answer <text>`
- `/quit`

## 12. How the current conversation mode behaves

The current default Q&A setup is:

- `60-second Pixel Cat mode`
- the model automatically decides:
  - the reply content
  - the cat animation or pose
  - the cat accessories or outfit

For example:

- travel prompts may use a travel hat
- science prompts may use a scholar hat
- food prompts may use a chef hat
- comforting prompts may use a scarf

## 13. Suggested test prompts

### Travel

- Plan a relaxed two-day trip to Hangzhou.
- Suggest a quiet weekend route in Suzhou.

### Science

- Explain black holes in one sentence.
- What is the difference between AI training and inference?

### Food

- Give me a simple dinner idea for tonight.
- Suggest three comforting breakfast options.

### Comfort

- I feel anxious today. Say something grounding.
- Encourage me gently after a difficult day.

## 14. Shortest routine restart flow

If the device is already flashed, provisioned, claimed, and Focus Listening was enabled before, your normal daily restart usually looks like this:

### Step 1: start the backend

```powershell
cd D:\6908\inksight\backend
.\.venv\Scripts\Activate.ps1
python -m uvicorn api.index:app --host 0.0.0.0 --port 8080
```

### Step 2: start the webapp only if you need the config page

```powershell
cd D:\6908\inksight\webapp
npm run dev
```

### Step 3: start the interactive Pixel Cat session

```powershell
cd D:\6908\inksight\backend
.\.venv\Scripts\Activate.ps1
python scripts\ask_screen.py http://127.0.0.1:8080 YOUR_DEVICE_MAC anything --provider deepseek --model deepseek-chat --api-key "your-real-key"
```

## 15. Common troubleshooting

### 15.1 The screen does not show Pixel Cat replies

Check these first:

1. the device and computer are on the same LAN
2. the provisioning page `Server URL` is set to `http://your-lan-ip:8080`, not `127.0.0.1`
3. `Focus Listening` is enabled
4. the device was restarted after enabling it
5. the backend terminal shows incoming requests

### 15.2 The device is online but the page behaves strangely

Try this order:

1. restart the backend
2. refresh the webapp
3. restart the device

### 15.3 Model errors appear in the CLI

Common causes:

- invalid API key
- insufficient balance or quota
- provider and model mismatch

Test the screen pipeline first with a fixed answer:

```powershell
python scripts\ask_screen.py http://127.0.0.1:8080 YOUR_DEVICE_MAC anything --answer "This is a direct screen test."
```

If that displays correctly, the screen pipeline is fine and the remaining problem is in your model configuration.

## 16. Most-used command list

### Backend setup

```powershell
cd D:\6908\inksight\backend
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
Copy-Item .env.example .env
```

### Backend start

```powershell
cd D:\6908\inksight\backend
.\.venv\Scripts\Activate.ps1
python -m uvicorn api.index:app --host 0.0.0.0 --port 8080
```

### Webapp start

```powershell
cd D:\6908\inksight\webapp
npm install
npm run dev
```

### Firmware flash

```powershell
cd D:\6908\inksight\firmware
pio run -e epd_42_wsv2_ssd1683_c3_promini -t upload
pio device monitor -b 115200
```

### Interactive ask_screen session

```powershell
cd D:\6908\inksight\backend
.\.venv\Scripts\Activate.ps1
python scripts\ask_screen.py http://127.0.0.1:8080 YOUR_DEVICE_MAC anything --provider deepseek --model deepseek-chat --api-key "your-real-key"
```
