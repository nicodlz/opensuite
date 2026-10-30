import type { SetupStatus } from "@opensuite/contracts";

const admin = {
  id: "admin",
  email: "admin@example.test",
  role: "admin",
} satisfies { id: string; email: string; role: "admin" | "user" };
const users: { id: string; email: string; role: "admin" | "user" }[] = [admin];
const status: SetupStatus = {
  database: "ready",
  stalwart: "ready",
  drive: "ready",
  objectStorage: "ready",
  relay: "ready",
  backup: "ready",
  backupAgeSeconds: 3600,
  mailDomain: "example.test",
};
export const syntheticSetup = {
  me: (
    _input: object,
  ): Promise<{ id: string; email: string; role: "admin" | "user" }> =>
    Promise.resolve(admin),
  status: (_input: object) => Promise.resolve(status),
  users: (_input: object) => Promise.resolve(structuredClone(users)),
  createUser: (input: { email: string; name: string; password: string }) => {
    if (
      input.email.toLowerCase().split("@")[1] !== status.mailDomain ||
      users.some((u) => u.email === input.email.toLowerCase())
    )
      return Promise.reject(new Error("Invalid user"));
    users.push({
      id: crypto.randomUUID(),
      email: input.email.toLowerCase(),
      role: "user",
    });
    return Promise.resolve({ created: true });
  },
};
