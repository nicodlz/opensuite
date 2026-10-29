// Only formats with a recognizable signature can be displayed inline.
export const verifiedType = (claimed: string, first: Buffer): string => {
  if (
    claimed === "image/png" &&
    first.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    return claimed;
  if (
    claimed === "image/jpeg" &&
    first.subarray(0, 3).equals(Buffer.from([255, 216, 255]))
  )
    return claimed;
  if (
    claimed === "image/gif" &&
    ["GIF87a", "GIF89a"].includes(first.subarray(0, 6).toString("ascii"))
  )
    return claimed;
  if (
    claimed === "image/webp" &&
    first.subarray(0, 4).toString("ascii") === "RIFF" &&
    first.subarray(8, 12).toString("ascii") === "WEBP"
  )
    return claimed;
  if (
    claimed === "application/pdf" &&
    first.subarray(0, 5).toString("ascii") === "%PDF-"
  )
    return claimed;
  return "application/octet-stream";
};
