// Client-side image compression for persona photos — stored as a base64
// data URL directly in personas.photoUrl (no external blob storage). Caps
// the longest edge at 800px and re-encodes as JPEG q0.8, which keeps typical
// phone photos well under the DB column's practical size budget.
export async function compressImage(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = reject;
    reader.onload = (e) => {
      const img = new Image();
      img.onerror = reject;
      img.onload = () => {
        const maxSize = 800;
        let { width, height } = img;
        if (width > maxSize || height > maxSize) {
          if (width > height) {
            height = Math.round((height * maxSize) / width);
            width = maxSize;
          } else {
            width = Math.round((width * maxSize) / height);
            height = maxSize;
          }
        }
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        if (!ctx) {
          reject(new Error("Canvas not supported"));
          return;
        }
        ctx.drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL("image/jpeg", 0.8));
      };
      img.src = e.target?.result as string;
    };
    reader.readAsDataURL(file);
  });
}

// Converts a Google Drive "share" link into a direct-download URL Duix/the
// wallpaper <img>/<video> can actually fetch. Returns null for anything that
// isn't a recognizable Drive URL — callers fall back to storing the raw
// pasted URL as-is (Dropbox, direct CDN links, etc. need no conversion).
export function convertGDriveUrl(url: string): string | null {
  const match = url.match(/drive\.google\.com\/file\/d\/([a-zA-Z0-9_-]+)/);
  if (match) {
    return `https://drive.google.com/uc?export=download&id=${match[1]}`;
  }
  if (url.includes("drive.google.com/uc?")) {
    return url;
  }
  return null;
}
