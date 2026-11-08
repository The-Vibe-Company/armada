import type { Database as Generated, MemberRole, Visibility } from "@armada/core";

/** The generated tables plus the functions of `20261108150000_dashboard_functions.sql`. */
export type Database = Omit<Generated, "public"> & {
  public: Omit<Generated["public"], "Functions"> & {
    Functions: {
      create_org: { Args: { org_name: string }; Returns: string };
      org_members: {
        Args: { target_org: string };
        Returns: { user_id: string; email: string; role: MemberRole; created_at: string }[];
      };
      add_org_member: { Args: { target_org: string; member_email: string; member_role: MemberRole }; Returns: string };
      set_golden_visibility: { Args: { target_golden: string; new_visibility: Visibility }; Returns: undefined };
    };
  };
};
