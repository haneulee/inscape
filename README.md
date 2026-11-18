# INSCAPE

Step inside a photograph. Drop an image and it becomes:

- **a solid diorama**: depth comes from in-browser monocular depth estimation (Depth Anything V2 via transformers.js, with a heuristic fallback). Every pixel becomes a point. Where something stands in front of something else, the gap behind it is filled with points, so objects get thickness and sides. Normals from the depth map catch a slowly orbiting light. The piece floats over a dotted floor, and you orbit around it or fly into it.
- **a song**: the image is read like a score. Left to right is time, height is pitch. The dominant colour picks the key, brightness and warmth pick the mode, saturation and contrast set the tempo and rhythm, and the pixel count sets the length. A glowing scanline shows which column the melody is reading.

Controls: drag to orbit, scroll or pinch to move in and out (all the way inside), `W A S D` to move, `Q`/`E` for down/up, `P` to play/pause.
The player bar has play/pause, a seekable waveform, loop, and `.wav` download.

## Stack
Static HTML + ES modules, no build step. Three.js and transformers.js load from jsDelivr.

## Run locally
```bash
python3 -m http.server 5178
```

## Deploy
Import the repo in Vercel with the **Other** framework preset and no build command. It's served as-is.
