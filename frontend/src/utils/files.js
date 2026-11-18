export const ACCEPTED_DOCUMENT_TYPES = 'application/pdf,image/jpeg,image/png';
export const MAX_DOCUMENT_BYTES = 2.5 * 1024 * 1024;

/**
 * Reads a File chosen in an <input type="file"> into the shape the document upload API expects.
 * Rejects files the server would refuse anyway, with a message a patient can act on.
 */
export function readDocumentFile(file) {
  return new Promise((resolve, reject) => {
    if (!file) return reject(new Error('Choose a file first.'));
    if (!ACCEPTED_DOCUMENT_TYPES.split(',').includes(file.type)) {
      return reject(new Error('Please choose a PDF, JPG, or PNG file.'));
    }
    if (file.size > MAX_DOCUMENT_BYTES) {
      return reject(new Error('That file is larger than 2.5 MB. Try a smaller photo or scan.'));
    }
    const reader = new FileReader();
    reader.onload = () => resolve({
      fileName: file.name,
      mimeType: file.type,
      contentBase64: String(reader.result).split(',')[1] || ''
    });
    reader.onerror = () => reject(new Error('The file could not be read.'));
    reader.readAsDataURL(file);
  });
}
