import type { Knex } from "knex";
import { AccountService } from "../../../../src/app/auth/service/account.service";
import { Logger } from "../../../../src/lib/logger/logger";
import type { MockedModule } from "../../../helpers/types";

jest.mock("../../../../src/app/auth/repository/user.repo", () => ({
  findLiveById: jest.fn(),
  findLiveByIdForUpdate: jest.fn(),
  listLive: jest.fn(),
  updateStatus: jest.fn(),
}));

const users = jest.requireMock<
  MockedModule<typeof import("../../../../src/app/auth/repository/user.repo")>
>("../../../../src/app/auth/repository/user.repo");

const trx = { tag: "trx" } as unknown as Knex;
const service = new AccountService(
  new Logger({ service: "identity-service", level: "debug", production: false, sink: () => undefined }),
);

describe("AccountService additions for the users module", () => {
  it("should lock the live row through the repository's FOR UPDATE read on the caller's transaction", async () => {
    const locked = { id: 5 };
    users.findLiveByIdForUpdate.mockResolvedValue(locked);

    await expect(service.lockLiveById(trx, 5)).resolves.toBe(locked);
    expect(users.findLiveByIdForUpdate).toHaveBeenCalledWith(5, trx);
  });

  it("should return undefined from lockLiveById when the account is absent or soft-deleted", async () => {
    users.findLiveByIdForUpdate.mockResolvedValue(undefined);

    await expect(service.lockLiveById(trx, 5)).resolves.toBeUndefined();
  });

  it("should update the status on the caller's transaction and return the updated entity", async () => {
    const updated = { id: 5, status: "suspended" };
    users.updateStatus.mockResolvedValue(updated);

    await expect(service.updateStatus(trx, 5, "suspended")).resolves.toBe(updated);
    expect(users.updateStatus).toHaveBeenCalledWith(5, "suspended", trx);
  });

  it("should surface an update that touched no row as undefined, never as success", async () => {
    users.updateStatus.mockResolvedValue(undefined);

    await expect(service.updateStatus(trx, 5, "active")).resolves.toBeUndefined();
  });

  it("should delegate the list to the repository with the filter, cursor and limit unchanged", async () => {
    const rows = [{ user: { id: 1 }, createdAtCursor: "x" }];
    users.listLive.mockResolvedValue(rows);
    const cursor = { createdAt: "2026-10-07T10:00:00.123456Z", id: 9 };

    await expect(service.listLive({ role: "patient", status: "active" }, cursor, 20)).resolves.toBe(rows);
    expect(users.listLive).toHaveBeenCalledWith({ role: "patient", status: "active" }, cursor, 20);
  });

  it("should read a live account by id on the given connection", async () => {
    users.findLiveById.mockResolvedValue({ id: 5 });

    await service.findLiveById(5, trx);

    expect(users.findLiveById).toHaveBeenCalledWith(5, trx);
  });
});
