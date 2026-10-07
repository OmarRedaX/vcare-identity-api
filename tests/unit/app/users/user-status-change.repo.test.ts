import type { Knex } from "knex";
import { UserStatus } from "../../../../src/app/auth/enums";
import * as statusChangeRepo from "../../../../src/app/users/repository/user-status-change.repo";
import type { NewStatusChange } from "../../../../src/app/users/types";

const ROW: NewStatusChange = {
  userId: 4,
  fromStatus: UserStatus.Active,
  toStatus: UserStatus.Suspended,
  actorUserId: 1,
  actorService: null,
  reason: "synthetic reason",
  requestId: "7f1c0000-0000-4000-8000-000000000001",
};

function fakeTrx(returned: unknown[]): { trx: Knex.Transaction; insert: jest.Mock } {
  const returning = jest.fn().mockResolvedValue(returned);
  const insert = jest.fn().mockReturnValue({ returning });
  const trx = jest.fn().mockReturnValue({ insert }) as unknown as Knex.Transaction;
  return { trx, insert };
}

describe("user-status-change repository (BR-17, append-only)", () => {
  it("should expose an insert function only, with no update or delete", () => {
    expect(Object.keys(statusChangeRepo)).toEqual(["insertStatusChange"]);
  });

  it("should insert the row with snake_case columns on the given transaction and return the numeric id", async () => {
    const { trx, insert } = fakeTrx([{ id: "17" }]);

    const id = await statusChangeRepo.insertStatusChange(ROW, trx);

    expect(id).toBe(17);
    expect(trx).toHaveBeenCalledWith("user_status_changes");
    expect(insert).toHaveBeenCalledWith({
      user_id: 4,
      from_status: "active",
      to_status: "suspended",
      actor_user_id: 1,
      actor_service: null,
      reason: "synthetic reason",
      request_id: "7f1c0000-0000-4000-8000-000000000001",
    });
  });

  it("should throw when the insert returns no row", async () => {
    const { trx } = fakeTrx([]);

    await expect(statusChangeRepo.insertStatusChange(ROW, trx)).rejects.toThrow(
      "user_status_change_insert_returned_no_row",
    );
  });
});
