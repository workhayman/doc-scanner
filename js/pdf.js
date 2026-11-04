/* Builds one A4 PDF from the processed pages, using jsPDF.
   'high': each page's saved JPEG is put into the PDF as it is (up to
           A4 at 300 dpi), so it is not compressed a second time.
   'small': pages are scaled to ~170 dpi and recompressed for a small file. */
const PDFBuilder = (() => {
  const SMALL_SIDE = 2000;

  function smallQuality(filter) {
    return filter === 'bw' ? 0.6 : filter === 'grey' ? 0.62 : 0.68;
  }

  async function build(pages, mode, onProgress) {
    const { jsPDF } = window.jspdf;
    let pdf = null;
    for (let i = 0; i < pages.length; i++) {
      onProgress && onProgress(i + 1, pages.length);
      await new Promise((r) => setTimeout(r, 0)); // let the UI repaint
      const page = pages[i];
      let data, iw, ih;
      if (mode !== 'small' && page.processed.type === 'image/jpeg' && page.pw && page.ph) {
        data = new Uint8Array(await page.processed.arrayBuffer());
        iw = page.pw; ih = page.ph;
      } else {
        const canvas = await Imaging.blobToCanvas(page.processed, mode === 'small' ? SMALL_SIDE : Imaging.PAGE_SIDE);
        iw = canvas.width; ih = canvas.height;
        data = Imaging.toDataURL(canvas, mode === 'small' ? smallQuality(page.filter) : 0.9);
        Imaging.release(canvas);
      }
      const orientation = iw > ih ? 'l' : 'p';
      if (!pdf) pdf = new jsPDF({ unit: 'mm', format: 'a4', orientation, compress: true });
      else pdf.addPage('a4', orientation);

      const pw = pdf.internal.pageSize.getWidth();
      const ph = pdf.internal.pageSize.getHeight();
      const s = Math.min(pw / iw, ph / ih);
      const w = iw * s, h = ih * s;
      const x = (pw - w) / 2, y = (ph - h) / 2;
      pdf.addImage(data, 'JPEG', x, y, w, h, undefined, 'NONE');
    }
    return pdf.output('blob');
  }

  function cleanTitle(title) {
    const t = (title || '').replace(/[\\/:*?"<>|]+/g, '').replace(/\s+/g, ' ').trim();
    return t || 'Scan';
  }

  function todayStamp() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }

  function filename(title) {
    return `${cleanTitle(title)}-${todayStamp()}.pdf`;
  }

  return { build, filename, cleanTitle };
})();
