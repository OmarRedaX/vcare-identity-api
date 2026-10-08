import "../../helpers/unreachable-redis-env";
import type { Express } from "express";
import request from "supertest";
import { buildTestApps } from "../../helpers/app";
import { seedUser } from "../../helpers/auth";
import { expectSuccessEnvelope } from "../../helpers/contract";
import { closeDb, truncateAll } from "../../helpers/db";
import { closeRedis } from "../../helpers/redis";
import { signCustomServiceToken } from "../../helpers/tokens";
import { historyRows, seedSession, liveTokenCount } from "../../helpers/users";

let internalApp: Express;

beforeAll(() => {
  internalApp = buildTestApps().internalApp;
});

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await closeRedis();
  await closeDb();
});

describe("/internal/users routes while Redis is unreachable (BR-17)", () => {
  it("should serve the batch lookup, the contacts lookup and the status change from Postgres alone", async () => {
    const doctor = await seedUser({ email: "redis.down.doctor@example.test", role: "doctor", status: "active" });
    await seedSession(doctor.id);
    const read = await signCustomServiceToken({ scope: "users:read" });
    const contact = await signCustomServiceToken({ scope: "users:contact:read" });
    const write = await signCustomServiceToken({ scope: "users:status:write" });

    const batch = await request(internalApp).get(`/internal/users?ids=${String(doctor.id)}`).set("Authorization", `Bearer ${read}`);
    const contacts = await request(internalApp)
      .get(`/internal/users/contacts?ids=${String(doctor.id)}`)
      .set("Authorization", `Bearer ${contact}`);
    const status = await request(internalApp)
      .patch(`/internal/users/${String(doctor.id)}/status`)
      .set("Authorization", `Bearer ${write}`)
      .send({ status: "suspended", reason: "Synthetic reason", actorUserId: 1 });

    expect(batch.status).toBe(200);
    expect(expectSuccessEnvelope(batch.body)).toHaveLength(1);
    expect(contacts.status).toBe(200);
    expect(expectSuccessEnvelope(contacts.body)).toHaveLength(1);
    expect(status.status).toBe(200);
    expect(await liveTokenCount(doctor.id)).toBe(0);
    expect(await historyRows(doctor.id)).toHaveLength(1);
  });
});
