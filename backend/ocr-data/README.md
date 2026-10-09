# OCR language data

`eng.traineddata` is the English model for Tesseract. It is committed so that OCR works with the network off (a dead
conference Wi-Fi must not break the demo) and so nothing is downloaded at run time.

- Obtained through `tesseract.js` 5.1.1, which fetches it from its default language-data server on first use.
- Tesseract and its trained data are published under the Apache License 2.0.
- Loaded from this folder by `../ocr.js` (`langPath`, `cacheMethod: 'none'`). Nothing else reads or writes it.
