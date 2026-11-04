# Doc Scanner

A small web app that turns your iPhone into a document scanner.
Point the camera at a page, it finds the edges, flattens the page, cleans it up,
and saves all pages as **one A4 PDF** that you can share to Files, WhatsApp,
Google Drive or AirDrop.

- Everything runs on the phone. No server, no account, no ads, no tracking.
- Works offline after the first load and can be added to the home screen.
- Plain HTML, CSS and JavaScript. Page detection and image cleanup with
  [OpenCV.js](https://docs.opencv.org/4.x/d5/d10/tutorial_js_root.html), PDF by [jsPDF](https://github.com/parallax/jsPDF).

The app will be available at:

```
https://<your-github-username>.github.io/doc-scanner/
```

---

## 1. Turn on GitHub Pages (one time)

1. Open the repository on GitHub.
2. Click **Settings** (top tab), then **Pages** in the left menu.
3. Under **Build and deployment**, set **Source** to **GitHub Actions**.
   (Do not pick "Deploy from a branch".)
4. Go to the **Actions** tab. If the "Deploy to GitHub Pages" run is red or missing,
   open it and press **Re-run all jobs** (or push any commit to `main`).
5. After about a minute the run turns green and the site is live at
   `https://<your-github-username>.github.io/doc-scanner/`.

Every push to `main` deploys again automatically.

---

## 2. Open it on your iPhone and add it to the home screen

### Safari
1. Open the link above in Safari.
2. Tap the **Share** button (the square with an arrow, bottom of the screen).
3. Scroll down and tap **Add to Home Screen**, then **Add**.

### Chrome (iOS 16.4 or newer)
1. Open the link above in Chrome.
2. Tap the **Share** icon (top right, square with an arrow) or the **⋯** menu.
3. Tap **Add to Home Screen**, then **Add**.

The first time you open the app it downloads the scanner engine (about 9 MB).
After that it works without internet. When you open it from the home screen,
allow **camera** access when asked.

---

## 3. How to use it

1. **Scan** – the camera opens. Hold the phone above the page. A green outline
   shows the page that was found. Hold still for about a second and the picture
   is taken automatically (**Auto: On**, top right; tap it to switch to manual).
   You can always tap the big round button yourself. The app looks at several
   frames and keeps the sharpest one, so a little hand shake does not blur the page.
   - **HD photo** (bottom left) uses the normal iPhone camera instead. It is the
     sharpest option because it is a real photo, not a frame of the live video.
     Use it for small print.
   - **Done** (bottom right) goes back to the page list.
2. **Adjust corners** – the corners are placed on the paper edge automatically.
   Drag the four blue circles if the outline is wrong.
   A magnifier helps you place them exactly. **Auto detect**, **Full image** and
   **Rotate** are there too. Tap **Next**.
3. **Preview** – choose **Enhance** (default: removes shadows, white paper, black crisp
   text, colours kept), **Original**, **Grey** or **B&W** (best for plain text).
   Tap **Add page**. The camera opens again for the next page.
4. **Page list** – tap a page to re-crop, change the filter, move it, retake or delete it.
   Hold and drag a thumbnail to reorder. **Import** lets you pick photos from your library.
5. **PDF** – type a title, pick **Sharp** (pages at full quality, about 0.3–1 MB each)
   or **Smaller file**, and tap **Create PDF**. The file is named
   `Title-YYYY-MM-DD.pdf`. Tap **Share / Save** to send it to Files, WhatsApp, Drive,
   AirDrop or any other app. **New document** clears the pages when you are done.

Pages are stored on the phone (IndexedDB) until you clear them, so nothing is lost
if the app closes mid-scan.

---

## Development

It is a static site. To run it locally:

```bash
python3 -m http.server 8000
```

Then open `http://localhost:8000/`. The camera needs HTTPS on a real phone;
GitHub Pages provides that.

| File | What it does |
| --- | --- |
| `index.html` | All screens (home, camera, crop, preview, export) |
| `css/style.css` | Styles, safe-area handling |
| `js/app.js` | Screen flow, camera, corner dragging, reorder, export |
| `js/scanner.js` | Loads OpenCV, finds the page and refines its corners, flattens, filters |
| `js/imaging.js` | Image decoding and downscaling (photos up to 4032 px, pages up to 3508 px) |
| `js/pdf.js` | Builds the A4 PDF with jsPDF |
| `js/db.js` | IndexedDB storage of pages |
| `sw.js` | Service worker: caches everything for offline use |
| `manifest.webmanifest` | Home-screen app settings and icons |
| `lib/` | Vendored OpenCV.js 4.7.0, jsPDF 2.5.2 |
| `.github/workflows/deploy.yml` | Deploys to GitHub Pages on every push to `main` |
