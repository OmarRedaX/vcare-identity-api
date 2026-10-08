import { UserStatus } from "../../../../src/app/auth/enums";
import { ADMIN_TRANSITIONS } from "../../../../src/app/users/status-transitions";

const ALL = Object.values(UserStatus);

function isAllowedPair(from: UserStatus, to: UserStatus): boolean {
  return (
    (from === UserStatus.Active && to === UserStatus.Suspended) ||
    (from === UserStatus.Suspended && to === UserStatus.Active)
  );
}

describe("ADMIN_TRANSITIONS (domain rule 3, admin caller)", () => {
  it("should contain exactly the pairs active to suspended and suspended to active", () => {
    const pairs = ALL.flatMap((from) => ADMIN_TRANSITIONS[from].map((to) => `${from}->${to}`)).sort();

    expect(pairs).toEqual(["active->suspended", "suspended->active"]);
  });

  it("should define an entry for every status so a new status is a compile-time decision", () => {
    expect(Object.keys(ADMIN_TRANSITIONS).sort()).toEqual([...ALL].sort());
  });

  it.each(
    ALL.flatMap((from) => ALL.map((to) => [from, to] as const)).filter(
      ([from, to]) => from !== to && !isAllowedPair(from, to),
    ),
  )("should refuse the pair %s to %s", (from, to) => {
    expect(ADMIN_TRANSITIONS[from]).not.toContain(to);
  });

  it("should offer no transition out of pending or rejected for an admin", () => {
    expect(ADMIN_TRANSITIONS[UserStatus.Pending]).toEqual([]);
    expect(ADMIN_TRANSITIONS[UserStatus.Rejected]).toEqual([]);
  });
});
