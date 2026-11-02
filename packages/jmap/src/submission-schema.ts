import { z } from "zod";
import { JmapCapability } from "./protocol.ts";

export const submissionCapabilities = [
  JmapCapability.core,
  JmapCapability.mail,
  JmapCapability.submission,
];

export const SubmissionCore = z.object({
  id: z.string(),
  emailId: z.string(),
  identityId: z.string(),
  undoStatus: z.enum(["pending", "final", "canceled"]),
});
