# INSCAPE

Step inside a photograph. Drop an image and it becomes:

- **a space**: every pixel turns into a point. Depth comes from in-browser monocular depth estimation (Depth Anything V2 via transformers.js), with a heuristic fallback.
- **a song**: the image is read like a score. Left to right is time, height is pitch. The dominant colour picks the key, brightness and warmth pick the mode, saturation and contrast set the tempo and rhythm, and the pixel count sets the length. A glowing scanline shows which column the melody is reading.

Controls: drag to look, `W A S D` to move, scroll to glide, `Q`/`E` to fall or rise, `P` to play/pause.
The player bar has play/pause, a seekable waveform, loop, and `.wav` download.

## Stack
Static HTML + ES modules, no build step. Three.js and transformers.js load from jsDelivr.

## Run locally
```bash
python3 -m http.server 5178
```

## Deploy
Import the repo in Vercel with the **Other** framework preset and no build command. It's served as-is.
