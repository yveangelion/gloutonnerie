/**
 * "Fast" panel detection: no model to download (unlike the ~236 MB best.onnx used by
 * detectPanelsWithIA in detectCase.jsx), just classic image processing — adaptive
 * thresholding + connected components. Near-instant and adds nothing to the bundle, at
 * the cost of lower accuracy on complex layouts (overlapping panels, uneven background,
 * heavily worn scans).
 *
 * Deliberately standalone from detectCase.jsx: nothing imports it yet — wire it into
 * App.jsx (in place of, or alongside, detectPanelsWithIA) whenever that's wanted.
 *
 * Returns the same shape as detectPanelsWithIA: an array of panels as percentages of the
 * page ({ x, y, w, h }), directly compatible with the rest of the app (sorting, overlay,
 * cropping...).
 */

/**
 * @param {HTMLImageElement} imgEl
 * @param {Object} options
 * @param {number} options.maxDimension - max working resolution in px (perf); the image
 *   is downscaled before analysis, which also has the side effect of smoothing out fine
 *   noise (scan grain, halftone). Default 700.
 * @param {number} options.minWidthPercent - minimum panel width, as a % of the page
 *   width. Default 8.
 * @param {number} options.minHeightPercent - minimum panel height, as a % of the page
 *   height. Default 5.
 * @param {number} options.dilateRadius - radius (in px, at the working resolution) of the
 *   dilation applied before looking for connected components: bridges panels whose
 *   gutter is nearly cut by a text balloon spilling over. Default 2.
 * @returns {Array<{x:number,y:number,w:number,h:number}>}
 */
export function detectPanelsLight(imgEl, options = {}) {
  const { maxDimension = 700, minWidthPercent = 8, minHeightPercent = 5, dilateRadius = 2 } = options;

  const naturalWidth = imgEl.naturalWidth;
  const naturalHeight = imgEl.naturalHeight;
  if (!naturalWidth || !naturalHeight) return [];

  // 1. Work on a downscaled version of the page: faster to analyze, and it smooths out
  //    fine scan grain along the way.
  const scale = Math.min(1, maxDimension / Math.max(naturalWidth, naturalHeight));
  const width = Math.max(1, Math.round(naturalWidth * scale));
  const height = Math.max(1, Math.round(naturalHeight * scale));

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(imgEl, 0, 0, width, height);
  const { data } = ctx.getImageData(0, 0, width, height);

  // 2. Grayscale
  const gray = new Uint8ClampedArray(width * height);
  for (let i = 0, j = 0; i < data.length; i += 4, j++) {
    gray[j] = (data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114) | 0;
  }

  // 3. Otsu thresholding: splits the page into two classes (light / dark) without
  //    assuming a specific background color up front.
  const threshold = otsuThreshold(gray);

  // 4. Which class is "the background"? Inferred from the page's outer margin (almost
  //    always outside any panel), rather than a single pixel like the old version did —
  //    more robust on scans with uneven contrast.
  const bordEstClair = margeMoyenne(gray, width, height) > threshold;

  // 5. Binarization: 1 = panel content, 0 = background/gutter
  const binary = new Uint8Array(width * height);
  for (let i = 0; i < gray.length; i++) {
    const estClair = gray[i] > threshold;
    binary[i] = estClair === bordEstClair ? 0 : 1;
  }

  // 6. Light dilation to bridge panels cut by a balloon/line that nearly touches the
  //    gutter edge.
  const dilated = dilateRadius > 0 ? dilate(binary, width, height, dilateRadius) : binary;

  // 7. Connected components on the dilated mask: each connected light region is a
  //    candidate panel.
  const { labels, count } = labelComponents(dilated, width, height);

  // 8. Bounding box of each component — recomputed on the original (non-dilated) pixels
  //    for a precise crop — then filtered by minimum size and converted to a percentage
  //    of the page.
  const boxes = bboxesOfLabels(labels, width, height, count, binary);

  const cases = [];
  for (const box of boxes) {
    if (!box) continue;
    const w = box.maxX - box.minX + 1;
    const h = box.maxY - box.minY + 1;
    const wPercent = (w / width) * 100;
    const hPercent = (h / height) * 100;
    if (wPercent < minWidthPercent || hPercent < minHeightPercent) continue;

    cases.push({
      x: (box.minX / width) * 100,
      y: (box.minY / height) * 100,
      w: wPercent,
      h: hPercent,
    });
  }

  return cases;
}

// ===================== Global Otsu thresholding =====================
// A single pass over the histogram: lightweight, and robust to contrast variation
// without the cost of local adaptive thresholding.
function otsuThreshold(gray) {
  const hist = new Array(256).fill(0);
  for (let i = 0; i < gray.length; i++) hist[gray[i]]++;
  const total = gray.length;

  let sum = 0;
  for (let t = 0; t < 256; t++) sum += t * hist[t];

  let sumB = 0,
    wB = 0,
    maxVar = 0,
    threshold = 0;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const varBetween = wB * wF * (mB - mF) * (mB - mF);
    if (varBetween > maxVar) {
      maxVar = varBetween;
      threshold = t;
    }
  }
  return threshold;
}

// Average brightness of the page's outer margin (all 4 edges), sampled at a fixed step
// to stay fast even on a large image.
function margeMoyenne(gray, width, height) {
  let sum = 0;
  let n = 0;

  const stepX = Math.max(1, Math.floor(width / 200));
  for (let x = 0; x < width; x += stepX) {
    sum += gray[x]; // top edge
    sum += gray[(height - 1) * width + x]; // bottom edge
    n += 2;
  }

  const stepY = Math.max(1, Math.floor(height / 200));
  for (let y = 0; y < height; y += stepY) {
    sum += gray[y * width]; // left edge
    sum += gray[y * width + (width - 1)]; // right edge
    n += 2;
  }

  return n > 0 ? sum / n : 0;
}

// Naive binary dilation (square kernel of the given radius): good enough at this reduced
// working resolution, no need for anything fancier just to bridge a gutter.
function dilate(binary, width, height, radius) {
  const out = new Uint8Array(binary.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      if (binary[idx] === 1) {
        out[idx] = 1;
        continue;
      }
      let trouve = false;
      for (let dy = -radius; dy <= radius && !trouve; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= height) continue;
        for (let dx = -radius; dx <= radius; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= width) continue;
          if (binary[ny * width + nx] === 1) {
            trouve = true;
            break;
          }
        }
      }
      out[idx] = trouve ? 1 : 0;
    }
  }
  return out;
}

// Connected-component labeling (4-connectivity), via a stack-based walk to avoid any
// risk of stack overflow on a large image.
function labelComponents(binary, width, height) {
  const labels = new Int32Array(width * height).fill(0);
  let current = 0;
  const stack = [];

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      if (binary[idx] !== 1 || labels[idx] !== 0) continue;

      current++;
      stack.push(idx);
      labels[idx] = current;

      while (stack.length) {
        const cur = stack.pop();
        const cx = cur % width;
        const cy = (cur / width) | 0;
        const voisins = [
          [cx - 1, cy],
          [cx + 1, cy],
          [cx, cy - 1],
          [cx, cy + 1],
        ];
        for (const [nx, ny] of voisins) {
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          const nIdx = ny * width + nx;
          if (binary[nIdx] === 1 && labels[nIdx] === 0) {
            labels[nIdx] = current;
            stack.push(nIdx);
          }
        }
      }
    }
  }

  return { labels, count: current };
}

// Bounding box of each label, computed in a single pass (rather than one pass per label)
// — only pixels from the original mask (before dilation) count, for a precise final crop
// despite the dilation used to help connectivity.
function bboxesOfLabels(labels, width, height, count, originalBinary) {
  const boxes = new Array(count + 1).fill(null);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      const label = labels[idx];
      if (label === 0 || originalBinary[idx] !== 1) continue;

      const b = boxes[label];
      if (!b) {
        boxes[label] = { minX: x, maxX: x, minY: y, maxY: y };
      } else {
        if (x < b.minX) b.minX = x;
        if (x > b.maxX) b.maxX = x;
        if (y < b.minY) b.minY = y;
        if (y > b.maxY) b.maxY = y;
      }
    }
  }

  return boxes.slice(1); // drop entry 0 (not an actual label)
}
