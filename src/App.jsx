/**
 * Main component: import a comic page → detect its panels (see detectPanelsLight.jsx)
 * → crop them into individual images → reorder/delete them in the preview → export as a
 * single vertically-stacked "webtoon" image (SAVE).
 *
 * Note: the AI detection path (detectCase.jsx, detectPanelsWithIA) still exists in the
 * project but isn't wired in here anymore — nothing in this file calls it.
 */
import { useEffect, useRef, useState } from "react";
import { detectPanelsLight } from "./detectPanelsLight";
import "./App.css";

// Reference width (px) at which the widest panel on the page is displayed in the
// preview — the other panels follow proportionally to their original width, exactly like
// the final export does (see globalScale in SAVE).
const APERCU_LARGEUR_REF = 210;

function App() {
  const [file, setFile] = useState(null);
  const [fileBrut, setFileBrut] = useState(null);
  const [fileName, setFileName] = useState(null);
  const [allCase, setAllCase] = useState(null);
  // Each panel carries its original width/height (px, taken from the page) alongside its
  // cropped image: this lets the sidebar and the export size each panel proportionally to
  // the space it actually took up on the page, with no manual setting.
  const [webtoonPanels, setWebtoonPanels] = useState([]);

  // Whether the preview (the "phone") holds more panels than what's visible without
  // scrolling — controls whether the "↓ more" cue at the bottom is shown.
  const [apercuADefiler, setApercuADefiler] = useState(false);
  const stripRef = useRef(null);

  const verifierDefilement = () => {
    const el = stripRef.current;
    if (!el) {
      setApercuADefiler(false);
      return;
    }
    setApercuADefiler(el.scrollHeight - el.scrollTop - el.clientHeight > 4);
  };

  useEffect(() => {
    verifierDefilement();
    // The first check right after mount can happen before the phone's layout has fully
    // settled (custom font, image decoding); we check again after the next paint to
    // catch that case.
    const raf = requestAnimationFrame(verifierDefilement);
    return () => cancelAnimationFrame(raf);
  }, [webtoonPanels]);

  // Crops the page according to the currently detected panels (allCase) and fills
  // webtoonPanels — this is what makes the webtoon preview appear in the sidebar.
  const CUT = () => {
    const img = new Image();
    img.src = file;
    setWebtoonPanels(extraireImagesDesCases(img, allCase));
  };

  // Called when the user picks a file via the hidden field inside .filebtn.
  const fileChange = (e) => {
    let newFile = e.target.files[0];
    if (!newFile) return;
    setFileBrut(newFile);
    detectCase(newFile);
  };

  // Runs panel detection on a page. Reused both for the first import and for the "Redo"
  // button.
  const detectCase = (File) => {
    setAllCase(null);
    setWebtoonPanels([]);

    setFileName(File.name);
    setFile(URL.createObjectURL(File));
    const img = new Image();
    img.src = URL.createObjectURL(File);

    img.onload = async () => {
      const casesTrouvees = detectPanelsLight(img, {});
      const casesTriees = casesTrouvees.sort((a, b) => {
        if (Math.abs(a.y - b.y) < 8) {
          return a.x - b.x;
        }
        return a.y - b.y;
      });
      console.log("Detected panels:", casesTrouvees);
      setAllCase(casesTriees);
    };
  };

  const SAVE = async () => {
    if (!webtoonPanels || webtoonPanels.length === 0) return;

    // 1. Load all the cropped images
    const promises = webtoonPanels.map((panel) => {
      return new Promise((resolve) => {
        const img = new Image();
        img.src = panel.src;
        img.onload = () => resolve(img);
      });
    });

    const loadedImages = await Promise.all(promises);

    // 🚀 A WIDTH BUDGET TO KEEP THE FILE LIGHT:
    // Instead of going up to 3000px or more, cap the max width at 1200px.
    // That's plenty for a screen, and it cuts the pixel count by 4!
    const maxLargeurCible = 1200;

    const paddingX = 30;
    const paddingY = 30;
    const gap = 20;

    const canvasWidth = maxLargeurCible;
    const availableWidth = canvasWidth - paddingX * 2;

    // A single shared scale for every panel: the widest one takes up the full available
    // width, the others follow proportionally. This faithfully preserves the panels'
    // relative proportions as they were on the original page (no artificial enlarging of
    // small panels).
    const maxImageWidth = Math.max(...loadedImages.map((img) => img.width));
    const globalScale = availableWidth / maxImageWidth;

    let totalHeight = paddingY;

    // 2. Compute positions
    const imagePositions = loadedImages.map((img) => {
      const dw = img.width * globalScale;
      const dh = img.height * globalScale;

      const dx = (canvasWidth - dw) / 2;
      const dy = totalHeight;

      totalHeight += dh + gap;
      return { img, dx, dy, dw, dh };
    });

    const canvasHeight = totalHeight - gap + paddingY;

    // 3. Final render onto the optimized canvas
    const canvas = document.createElement("canvas");
    canvas.width = canvasWidth;
    canvas.height = canvasHeight;
    const ctx = canvas.getContext("2d");

    // White background is required for the JPEG
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvasWidth, canvasHeight);

    // Draw the images onto the canvas
    imagePositions.forEach(({ img, dx, dy, dw, dh }) => {
      ctx.drawImage(img, 0, 0, img.width, img.height, dx, dy, dw, dh);
    });
    const dataUrl = canvas.toDataURL("image/jpeg", 0.8);

    const link = document.createElement("a");
    link.download = fileName.split(".")[0] + ".jpg";
    link.href = dataUrl;
    link.click();
  };

  // Deletes a panel: the entry needs to be removed from both webtoonPanels (the
  // preview/export) and allCase (the boxes on the page), otherwise the two lists drift
  // out of sync.
  const deletePanel = (DeleteIndex) => {
    setWebtoonPanels((prevPanels) =>
      prevPanels.filter((_, index) => index !== DeleteIndex),
    );
    setAllCase((prevCase) =>
      prevCase.filter((_, index) => index !== DeleteIndex),
    );
  };

  // Swaps the panel with the previous one. The guard (index <= 0) avoids writing to a
  // non-existent index -1: without it, moving the very first panel up would corrupt the
  // array.
  const upPanel = (index) => {
    if (index <= 0) return;
    setWebtoonPanels((prevSelections) => {
      const nouvelleListe = [...prevSelections];
      [nouvelleListe[index], nouvelleListe[index - 1]] = [
        nouvelleListe[index - 1],
        nouvelleListe[index],
      ];

      return nouvelleListe;
    });
  };

  // Mirror of upPanel: swaps the panel with the next one, same guard at the end of the
  // list.
  const downPanel = (index) => {
    if (index >= webtoonPanels.length - 1) return;
    setWebtoonPanels((prevSelections) => {
      const nouvelleListe = [...prevSelections];
      [nouvelleListe[index + 1], nouvelleListe[index]] = [
        nouvelleListe[index],
        nouvelleListe[index + 1],
      ];

      return nouvelleListe;
    });
  };

  // Crops each detected panel (coordinates as % of the page) into a standalone image,
  // keeping its original width/height in pixels — see the comment on webtoonPanels above
  // for what those are used for afterwards.
  const extraireImagesDesCases = (imgElement, cases) => {
    const imagesDecoupees = [];

    cases.forEach((c) => {
      // 1. Convert percentages to actual pixels relative to the source image
      const pxX = (c.x / 100) * imgElement.naturalWidth;
      const pxY = (c.y / 100) * imgElement.naturalHeight;
      const pxW = (c.w / 100) * imgElement.naturalWidth;
      const pxH = (c.h / 100) * imgElement.naturalHeight;

      // 2. Create a canvas sized exactly to the panel
      const canvas = document.createElement("canvas");
      canvas.width = pxW;
      canvas.height = pxH;
      const ctx = canvas.getContext("2d");

      // 3. Draw only that portion of the image onto this canvas
      // ctx.drawImage(imageSource, sourceX, sourceY, sourceW, sourceH, destX, destY, destW, destH)
      ctx.drawImage(imgElement, pxX, pxY, pxW, pxH, 0, 0, pxW, pxH);

      // 4. Export the canvas as an image URL (Base64), along with its original
      // width/height (used afterwards to size the panel proportionally in the sidebar
      // and the export)
      const dataUrl = canvas.toDataURL("image/jpeg", 0.9); // 0.9 = JPEG quality at 90%
      imagesDecoupees.push({ src: dataUrl, width: pxW, height: pxH });
    });

    return imagesDecoupees;
  };

  // Shared by both screens (before and after detection): file import, and — once panels
  // have been detected — Redo/Cut.
  const toolbar = (
    <div className="toolbar">
      <p className="wordmark">
        Glouton<span className="accent">nerie</span>
      </p>
      <label className="filebtn">
        {fileName || "Choose a page…"}
        <input type="file" accept="image/*" multiple onChangeCapture={fileChange} />
      </label>
      {allCase && (
        <div className="btnrow">
          <button className="btn" onClick={() => detectCase(fileBrut)}>
            Redo
          </button>
          <button className="btn primary" onClick={CUT}>
            Cut
          </button>
        </div>
      )}
    </div>
  );

  if (!allCase) return toolbar;

  return (
    <>
      {toolbar}
      <div className="app-layout">
        <div className="planche-viewer">
          <div className="plate">
            {/* Adds the .comic-image class to preserve the page's aspect ratio */}
            <img src={file} className="comic-image" alt="Comic page" />

            {allCase.map((o, index) => (
              <div
                key={index}
                className="comic-panel"
                style={{
                  // Apply the percentages returned by detectCase directly
                  left: `${o.x}%`,
                  top: `${o.y}%`,
                  width: `${o.w}%`,
                  height: `${o.h}%`,
                }}
              >
                <span className="panel-number">{index + 1}</span>
              </div>
            ))}
          </div>
        </div>

        {webtoonPanels.length > 0 && (
          <div className="sidebar">
            <p className="sidebar-title">Webtoon preview</p>
            <p className="sidebar-sub">
              {webtoonPanels.length} panel{webtoonPanels.length > 1 ? "s" : ""} stacked, at the export's actual scale.
            </p>

            <div className="phone">
              <div className="phone-notch"></div>
              <div className="strip" ref={stripRef} onScroll={verifierDefilement}>
                {(() => {
                  // The widest panel acts as the reference (takes up the full screen
                  // width); the others follow proportionally — same logic as globalScale
                  // in SAVE, so the preview truly matches the final export.
                  const largeurCaseMax = Math.max(...webtoonPanels.map((p) => p.width));

                  return webtoonPanels.map((panel, index) => {
                    const largeur = (panel.width / largeurCaseMax) * APERCU_LARGEUR_REF;
                    const hauteur = (panel.height / panel.width) * largeur;

                    return (
                      <div className="panel-row" key={index} style={{ width: `${largeur}px`, height: `${hauteur}px` }}>
                        <img src={panel.src} alt={`Panel ${index + 1}`} />
                        <span className="panel-tag">№{String(index + 1).padStart(2, "0")}</span>
                        <div className="panel-ctrl">
                          <button className="icon" onClick={() => upPanel(index)} disabled={index === 0} aria-label="Move panel up">
                            ▲
                          </button>
                          <button
                            className="icon"
                            onClick={() => downPanel(index)}
                            disabled={index === webtoonPanels.length - 1}
                            aria-label="Move panel down"
                          >
                            ▼
                          </button>
                          <button className="icon danger" onClick={() => deletePanel(index)} aria-label="Delete panel">
                            ✕
                          </button>
                        </div>
                      </div>
                    );
                  });
                })()}
              </div>
              {apercuADefiler && (
                <div className="phone-fade">
                  <span className="scroll-cue">↓ more</span>
                </div>
              )}
            </div>

            <button className="export-btn" onClick={SAVE}>
              Export webtoon
            </button>
          </div>
        )}
      </div>
    </>
  );
}

export default App;
