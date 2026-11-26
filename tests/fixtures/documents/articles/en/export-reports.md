---
title: "Export a report"
description: How to download a report as a spreadsheet
order: 3
---

# Export a report

Open **Reports** and pick the one you need. Press {{ui.save}} when the filters look right 🎉

1. Choose a date range, up to 90 days.
2. Select `CSV` or `XLSX`.
3. Press [Download](https://example.com/help/downloads).

![The export dialog](../images/export-dialog.png)

```bash
curl -H "Authorization: Bearer $TOKEN" https://example.com/api/reports/42
```

Hello {{ name }}, the file lands in your downloads folder.
