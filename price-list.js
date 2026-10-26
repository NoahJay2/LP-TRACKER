/* Customer-facing PDF export. Kept separate from the app's private inventory exports. */
(function () {
  const money = value => '$' + Math.round(value).toLocaleString('en-US');
  function rowsFor(stock, options) {
    return stock.filter(p => (!options.category || options.category === 'all' || p.category === options.category)
      && (!options.inStock || (Number(p.qty) > 0 && p.status !== 'OUT OF STOCK')))
      .map(p => {
        const current = Math.max(0, Number(p.price) || 0);
        return { name: String(p.name || 'Unnamed item'), imageUrl: String(p.imageUrl || ''), category: String(p.categoryLabel || p.category || ''),
          current, regular: Math.max(current, Number(p.originalPrice) || 0) };
      }).sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
  }

  function createPDF(PDF, rows, options = {}) {
    // Measure every row before creating the page. Large lists grow the single
    // sheet rather than silently dropping items or shrinking type to illegibility.
    const columns = rows.length > 40 ? 3 : rows.length > 16 ? 2 : 1;
    const width = columns === 3 ? 1224 : columns === 2 ? 792 : 612;
    const margin = 36, gap = 24;
    const colWidth = (width - margin * 2 - gap * (columns - 1)) / columns;
    const nameWidth = colWidth - 148;
    const ink = '#203249', blue = '#245C8A', muted = '#7A8796';
    const title = String(options.title || 'Price list').slice(0, 80);
    const measure = new PDF({ unit: 'pt' });
    measure.setFont('helvetica', 'normal'); measure.setFontSize(15);
    const titleLines = measure.splitTextToSize(title, width - margin * 2);
    const tableTop = 133 + titleLines.length * 18;
    measure.setFont('helvetica', 'normal'); measure.setFontSize(9.5);
    const measured = rows.map(row => {
      const lines = measure.splitTextToSize(row.name, nameWidth);
      return { ...row, lines, height: Math.max(38, lines.length * 11 + 20) };
    });
    // Partition contiguous alphabetical rows by height for balanced columns.
    const groups = [];
    let offset = 0;
    for (let col = 0; col < columns; col++) {
      const remaining = measured.slice(offset);
      const target = remaining.reduce((sum, row) => sum + row.height, 0) / (columns - col);
      const group = [];
      let height = 0;
      while (offset < measured.length) {
        const row = measured[offset];
        if (col < columns - 1 && group.length && height + row.height / 2 > target) break;
        group.push(row); height += row.height; offset++;
      }
      groups.push({ rows: group, height });
    }
    const height = Math.max(columns === 2 ? 612 : 792, tableTop + 22 + Math.max(0, ...groups.map(g => g.height)) + 48);
    if (height > 14400) throw new Error('This selection is too large for one PDF page. Export one category at a time.');
    const doc = new PDF({ unit: 'pt', format: [width, height], orientation: width > height ? 'landscape' : 'portrait' });
    doc.setProperties({ title, author: 'Lumen Research', subject: 'Customer price list' });
    const center = width / 2;
    if (options.logo) doc.addImage(options.logo, 'PNG', center - 22, 20, 44, 44);
    doc.setFont('times', 'normal'); doc.setFontSize(24); doc.setTextColor(ink);
    doc.text('Lumen Research', center, 89, { align: 'center' });
    doc.setFont('helvetica', 'normal'); doc.setFontSize(15); doc.setTextColor(blue);
    doc.text(titleLines, center, 113, { align: 'center', lineHeightFactor: 18 / 15 });
    doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(muted);
    doc.text([options.date, 'Prices in USD'].filter(Boolean).join('  |  '), center, tableTop - 18, { align: 'center' });
    groups.forEach((group, col) => {
      const x = margin + col * (colWidth + gap), right = x + colWidth;
      let y = tableTop;
      doc.setFillColor('#F0F4F7'); doc.roundedRect(x, y, colWidth, 22, 4, 4, 'F');
      doc.setFont('helvetica', 'bold'); doc.setFontSize(8); doc.setTextColor(ink);
      doc.text('Item', x + 8, y + 14);
      doc.text('Regular', right - 58, y + 14, { align: 'right' });
      doc.text('Current', right - 7, y + 14, { align: 'right' });
      y += 22;
      group.rows.forEach(row => {
        const thumb = options.images?.get(row.imageUrl);
        let hasImage = false;
        if (thumb) {
          try {
            const scale = 26 / Math.max(thumb.width, thumb.height);
            const w = thumb.width * scale, h = thumb.height * scale;
            doc.addImage(thumb.data, 'PNG', x + 5 + (26 - w) / 2, y + (row.height - h) / 2, w, h);
            hasImage = true;
          } catch { /* A damaged thumbnail must not prevent the export. */ }
        }
        if (!hasImage) {
          doc.setFillColor('#F3F5F7'); doc.roundedRect(x + 5, y + (row.height - 26) / 2, 26, 26, 5, 5, 'F');
          doc.setFont('helvetica', 'bold'); doc.setFontSize(9); doc.setTextColor(muted);
          doc.text(row.name.slice(0, 2).toUpperCase(), x + 18, y + row.height / 2 + 3, { align: 'center' });
        }
        doc.setFont('helvetica', 'normal'); doc.setFontSize(9.5); doc.setTextColor(ink);
        doc.text(row.lines, x + 38, y + 15, { lineHeightFactor: 11 / 9.5 });
        doc.setFontSize(7); doc.setTextColor(muted);
        doc.text(doc.splitTextToSize(row.category, nameWidth)[0] || '', x + 38, y + row.height - 6);
        doc.setFontSize(8.5);
        doc.text(money(row.regular), right - 58, y + 16, { align: 'right' });
        doc.setFont('helvetica', 'bold'); doc.setFontSize(9.5); doc.setTextColor(blue);
        doc.text(money(row.current), right - 7, y + 16, { align: 'right' });
        if (row.regular > row.current) {
          doc.setFont('helvetica', 'normal'); doc.setFontSize(7);
          doc.text('Sale', right - 7, y + 27, { align: 'right' });
        }
        doc.setLineWidth(0.35); doc.setDrawColor('#E9EDF1'); doc.line(x, y + row.height, right, y + row.height);
        y += row.height;
      });
    });
    doc.setDrawColor('#E9EDF1'); doc.line(margin, height - 32, width - margin, height - 32);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(7); doc.setTextColor(muted);
    doc.text('Prices and availability subject to change.', center, height - 19, { align: 'center' });
    doc.text('Page 1 of 1', width - margin, height - 19, { align: 'right' });
    return doc;
  }

  async function loadProductImage(url) {
    if (!url) return null;
    let timer;
    try {
      const image = new Image();
      image.crossOrigin = 'anonymous';
      image.src = url;
      await Promise.race([image.decode(), new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Image timed out')), 5000);
      })]);
      const scale = Math.min(1, 120 / Math.max(image.naturalWidth, image.naturalHeight));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
      canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
      return { data: canvas.toDataURL('image/png'), width: canvas.width, height: canvas.height };
    } catch { return null; } // Includes missing images and cross-origin restrictions.
    finally { clearTimeout(timer); }
  }

  let loading;
  function loadPDF() {
    if (window.jspdf?.jsPDF) return Promise.resolve(window.jspdf.jsPDF);
    if (loading) return loading;
    loading = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      const timer = setTimeout(() => fail(), 20000);
      function fail() { clearTimeout(timer); script.remove(); loading = null; reject(new Error('Could not load PDF export. Check your connection and try again.')); }
      script.src = 'https://cdn.jsdelivr.net/npm/jspdf@4.2.1/dist/jspdf.umd.min.js';
      script.onload = () => { clearTimeout(timer); window.jspdf?.jsPDF ? resolve(window.jspdf.jsPDF) : fail(); };
      script.onerror = fail;
      document.head.appendChild(script);
    });
    return loading;
  }
  async function download(rows, options) {
    const PDF = await loadPDF();
    const logo = new Image();
    logo.src = new URL('public/lr-logo.png', document.baseURI).href;
    let timer;
    try {
      await Promise.race([logo.decode(), new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Logo loading timed out. Please try again.')), 15000);
      })]);
    } catch {
      throw new Error('Could not load the logo. Check your connection and try again.');
    } finally { clearTimeout(timer); }
    const urls = [...new Set(rows.map(row => row.imageUrl).filter(Boolean))];
    const images = new Map(await Promise.all(urls.map(async url => [url, await loadProductImage(url)])));
    createPDF(PDF, rows, { ...options, logo, images }).save(`lumen-price-list-${options.fileDate}.pdf`);
  }
  window.LumenPriceList = { rowsFor, createPDF, download };
}());
