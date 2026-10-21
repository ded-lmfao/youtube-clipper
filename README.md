# YouTube Clipper

A SaaS tool that allows users to extract specific clips from YouTube videos by providing a URL and start/end timestamps. Clips are processed efficiently and downloaded directly to your computer. Open source for folks who can't afford it and know how code works!

---

## Features

- **Frontend:** NextJS + TailwindCSS (with Shadcn/UI)
- **Backend:** Node.js (Express) with Bun runtime
- **Video Processing:** Uses `yt-dlp` and `ffmpeg` for efficient, compatible video clipping
- **No cloud storage required:** Clips are downloaded directly to your device

The clipping flow runs locally without Supabase, login, or a subscription. Both
servers listen only on loopback. Finished clips are downloaded as `clip.mp4`
through your browser; no public download link is created. Set your browser's
download location to your Downloads folder and disable “Ask where to save each
file” if you want downloads to save there automatically.

Temporary clips live in `backend/uploads` and are removed after the browser
receives the download. Interrupted downloads may leave temporary files there;
job status is held in memory and resets when the backend restarts.

---

## Prerequisites

You must have the following installed on your system:

- **[Bun](https://bun.sh/):** `bun` (v1.2.7 or later)
- **[Node.js](https://nodejs.org/):** `node` (v18+ recommended)
- **[npm](https://www.npmjs.com/):** (for some tooling, v10+)
- **[yt-dlp](https://github.com/yt-dlp/yt-dlp):** Command-line tool for downloading YouTube videos
- **[ffmpeg](https://ffmpeg.org/):** Command-line tool for video processing

### To check if you have these installed, run:

```sh
bun --version
node --version
npm --version
yt-dlp --version
ffmpeg -version
```

If any are missing, install them via your package manager (e.g., `brew install bun yt-dlp ffmpeg` on macOS).

---

## Getting Started

### 1. Clone the repository

```sh
git clone https://github.com/retrogtx/youtube-clipper
cd youtube-clipper
```

---

### 2. Install dependencies

#### Backend

```sh
cd backend
bun install
```

#### Frontend

```sh
cd ../frontend
bun install
```

On Windows, install Bun from PowerShell if it is not already installed:

```powershell
powershell -c "irm bun.sh/install.ps1 | iex"
```

Restart PowerShell after installation, then install the dependencies:

```powershell
cd backend
bun install
cd ..\frontend
bun install
```

---

### 3. Run the app

To start the backend first and then the frontend with one command, run this from the repository root:

```sh
bash run-dev.sh
```

Press `Ctrl+C` to stop both development servers.

On Windows PowerShell, use:

```powershell
.\run-dev.ps1
```

If you are currently inside the `backend` directory, use:

```powershell
..\run-dev.ps1
```

If PowerShell blocks the script because of the execution policy, run:

```powershell
powershell -ExecutionPolicy Bypass -File ..\run-dev.ps1
```

You can also start each server separately:

#### Start the backend

```sh
cd backend
bun run src/index.ts
```

- The backend will start on `http://localhost:3001` by default.

#### Start the frontend

```sh
cd ../frontend
bun run dev
```

- The frontend will start on `http://localhost:3000` by default.

---

## Usage

1. Open the frontend in your browser (`http://localhost:3000`).
2. Enter a YouTube URL and the desired start/end timestamps (format: `HH:MM:SS`).
3. Click "Clip Video".
4. The processed clip will be downloaded directly to your computer as `clip.mp4`.

---

## Required System Packages

- **yt-dlp**: Used for partial YouTube downloads.
- **ffmpeg**: Used for video/audio processing and re-encoding.
- **bun**: Used as the JavaScript/TypeScript runtime for both backend and frontend.
- **node** and **npm**: For compatibility and tooling.

---

## Project Structure

```
youtube-clipper/
  backend/
    src/
    uploads/
    package.json
    tsconfig.json
  frontend/
    app/
    public/
    components/
    package.json
    tsconfig.json
    next.config.ts
```

---

## Troubleshooting

- **yt-dlp or ffmpeg not found:**  
  Make sure both are installed and available in your system PATH.
  On Windows, use `yt-dlp.exe` on PATH (or in `backend/bin`); the bundled
  extensionless `yt-dlp` is for Unix systems.
  You can also place `ffmpeg.exe` and `ffprobe.exe` in `backend/bin`; the
  backend and yt-dlp will use them without changing your system PATH.
  Restart the backend after installing these tools.
- **Video fails to upload to Twitter:**  
  The backend re-encodes all clips for Twitter compatibility. If you still have issues, ensure your ffmpeg is up to date.
- **Port conflicts:**  
  Change the port in the backend or frontend config if needed.

---

## Development

- TypeScript is used throughout.
- Hot reload is NOT enabled.
- Linting is available via `bun run lint` in the frontend.

---

**Enjoy clipping YouTube videos!**

If you have any issues, please open an issue or PR.
