/**
 * AI-based panel detection: a YOLO model (mosesb/best-comic-panel-detection, see
 * "test colab.py" at the root of src/ for the training/export script) exported to ONNX,
 * run in the browser via onnxruntime-web. More accurate than detectPanelsLight.jsx on
 * complex layouts, at the cost of a ~236 MB model to load (public/best.onnx) and a
 * non-trivial inference time.
 */
import * as ort from "onnxruntime-web";

// Only relevant to the webgpu backend — currently unused since executionProviders below
// only requests "wasm" (webgpu turned out to be unavailable in practice, see the
// project's history). Left in place: harmless, just has no effect.
ort.env.webgpu.forceSequentialExecution = true;

export async function detectPanelsWithIA(imgEl, modelUrl = "/best.onnx") {
  try {
    // 1. Session setup
    const absoluteUrl = new URL(modelUrl, window.location.origin).href;
    const session = await ort.InferenceSession.create(absoluteUrl, {
      executionProviders: ["wasm"],
    });

    // 2. Prepare a 640x640 canvas with letterboxing (preserves aspect ratio)
    const canvas = document.createElement("canvas");
    canvas.width = 640;
    canvas.height = 640;
    const ctx = canvas.getContext("2d");

    // Black background for the letterboxing
    ctx.fillStyle = "#000000";
    ctx.fillRect(0, 0, 640, 640);

    // Compute how to center the image without distorting it
    const ratio = Math.min(640 / imgEl.naturalWidth, 640 / imgEl.naturalHeight);
    const newWidth = imgEl.naturalWidth * ratio;
    const newHeight = imgEl.naturalHeight * ratio;
    const xOffset = (640 - newWidth) / 2;
    const yOffset = (640 - newHeight) / 2;

    ctx.drawImage(imgEl, xOffset, yOffset, newWidth, newHeight);
    const { data } = ctx.getImageData(0, 0, 640, 640);

    // 3. Convert to a Float32 tensor (normalization)
    const floatData = new Float32Array(3 * 640 * 640);
    for (let i = 0; i < 640 * 640; i++) {
      floatData[i] = data[i * 4] / 255.0;
      floatData[i + 640 * 640] = data[i * 4 + 1] / 255.0;
      floatData[i + 2 * 640 * 640] = data[i * 4 + 2] / 255.0;
    }
    const inputTensor = new ort.Tensor("float32", floatData, [1, 3, 640, 640]);

    // 4. Inference
    const feeds = { [session.inputNames[0]]: inputTensor };
    const outputMap = await session.run(feeds);
    const outputTensor = outputMap[session.outputNames[0]];
    const output = outputTensor.data;
    const dims = outputTensor.dims;

    // 5. Dynamic decoding (adapts to the model's actual output shape)
    const numPredictions = dims[2];
    const candidates = [];
    const confThreshold = 0.45;

    for (let i = 0; i < numPredictions; i++) {
      const confidence = output[4 * numPredictions + i];

      if (confidence > confThreshold) {
        // Extract raw coordinates in the 640x640 frame
        const cx = output[i];
        const cy = output[numPredictions + i];
        const w = output[2 * numPredictions + i];
        const h = output[3 * numPredictions + i];

        // FIX 1: just subtract the offsets (the black bars) to get the position
        // relative to the "real" image within the canvas
        candidates.push({
          x: cx - w / 2 - xOffset,
          y: cy - h / 2 - yOffset,
          w: w,
          h: h,
          confidence: confidence,
        });
      }
    }

    // 6. Cleanup (NMS) and conversion to percentages
    const finalBoxes = nonMaximumSuppression(candidates, 0.45);

    return finalBoxes.map((box) => ({
      // FIX 2: direct, clean percentage computation
      x: Math.max(0, Math.min(100, (box.x / newWidth) * 100)),
      y: Math.max(0, Math.min(100, (box.y / newHeight) * 100)), // y uses newHeight
      w: Math.max(1, Math.min(100, (box.w / newWidth) * 100)),
      h: Math.max(1, Math.min(100, (box.h / newHeight) * 100)), // h uses newHeight (not 640)
    }));
  } catch (error) {
    console.error("AI error:", error);
    return [];
  }
}

// The model often proposes several near-identical boxes for the same panel (see
// "candidates" above). We keep the most confident one and drop the ones that overlap it
// too much (IoU > iouThreshold), processing boxes from most to least confident.
function nonMaximumSuppression(boxes, iouThreshold) {
  boxes.sort((a, b) => b.confidence - a.confidence);
  const picked = [];
  const suppressed = new Set();
  for (let i = 0; i < boxes.length; i++) {
    if (suppressed.has(i)) continue;
    picked.push(boxes[i]);
    for (let j = i + 1; j < boxes.length; j++) {
      if (suppressed.has(j)) continue;
      const boxA = boxes[i];
      const boxB = boxes[j];
      const x1 = Math.max(boxA.x, boxB.x);
      const y1 = Math.max(boxA.y, boxB.y);
      const x2 = Math.min(boxA.x + boxA.w, boxB.x + boxB.w);
      const y2 = Math.min(boxA.y + boxA.h, boxB.y + boxB.h);
      const intersectionArea = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
      const unionArea = boxA.w * boxA.h + boxB.w * boxB.h - intersectionArea;
      if (unionArea > 0 && intersectionArea / unionArea > iouThreshold) suppressed.add(j);
    }
  }
  return picked;
}
