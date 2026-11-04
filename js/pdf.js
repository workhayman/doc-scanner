/* Builds one A4 PDF from the processed pages, using jsPDF.
   Each page is re-encoded as JPEG at about 210 dpi for A4, which keeps
   small print sharp while the file stays a reasonable size. */
const PDFBuilder = (() => {
  const PDF_SIDE = 2480;   // px on the long side inside the PDF (~210 dpi on A4)

  function quality(filter) {
    return filter === 'bw' ? 0.7 : filter === 'grey' ? 0.72 : 0.78;
  }

  async function build(pages, onProgress) {
    const { jsPDF } = window.jspdf;
    let pdf = null;
    for (let i = 0; i < pages.length; i++) {
      onProgress && onProgress(i + 1, pages.length);
      await new Promise((r) => setTimeout(r, 0)); // let the UI repaint
      const page = pages[i];
      const canvas = await Imaging.blobToCanvas(page.processed, PDF_SIDE);
      const landscape = canvas.width > canvas.height;
      const orientation = landscape ? 'l' : 'p';
      if (!pdf) pdf = new jsPDF({ unit: 'mm', format: 'a4', orientation, compress: true });
      else pdf.addPage('a4', orientation);

      const pw = pdf.internal.pageSize.getWidth();
      const ph = pdf.internal.pageSize.getHeight();
      const s = Math.min(pw / canvas.width, ph / canvas.height);
      const w = canvas.width * s, h = canvas.height * s;
      const x = (pw - w) / 2, y = (ph - h) / 2;
      const data = Imaging.toDataURL(canvas, quality(page.filter));
      Imaging.release(canvas);
      pdf.addImage(data, 'JPEG', x, y, w, h, undefined, 'FAST');
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
