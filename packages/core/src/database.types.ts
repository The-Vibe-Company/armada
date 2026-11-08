// Generated from supabase/migrations by `bun run db:types`. Do not edit.
export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export type Database = {
  public: {
    Tables: {
      credentials: {
        Row: {
          id: string;
          scope: Database["public"]["Enums"]["credential_scope"];
          owner_id: string;
          kind: Database["public"]["Enums"]["credential_kind"];
          value_enc: string;
          created_at: string;
        };
        Insert: {
          id?: string;
          scope: Database["public"]["Enums"]["credential_scope"];
          owner_id: string;
          kind: Database["public"]["Enums"]["credential_kind"];
          value_enc: string;
          created_at?: string;
        };
        Update: {
          id?: string;
          scope?: Database["public"]["Enums"]["credential_scope"];
          owner_id?: string;
          kind?: Database["public"]["Enums"]["credential_kind"];
          value_enc?: string;
          created_at?: string;
        };
        Relationships: [];
      };
      goldens: {
        Row: {
          id: string;
          org_id: string;
          name: string;
          visibility: Database["public"]["Enums"]["visibility"];
          owner_id: string;
          boat_snapshot_id: string | null;
          config: Json;
          created_at: string;
        };
        Insert: {
          id?: string;
          org_id: string;
          name: string;
          visibility: Database["public"]["Enums"]["visibility"];
          owner_id: string;
          boat_snapshot_id?: string | null;
          config?: Json;
          created_at?: string;
        };
        Update: {
          id?: string;
          org_id?: string;
          name?: string;
          visibility?: Database["public"]["Enums"]["visibility"];
          owner_id?: string;
          boat_snapshot_id?: string | null;
          config?: Json;
          created_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "goldens_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "goldens_owner_id_fkey";
            columns: ["owner_id"];
            isOneToOne: false;
            referencedRelation: "users";
            referencedColumns: ["id"];
          },
        ];
      };
      mcp_tokens: {
        Row: {
          id: string;
          user_id: string;
          org_id: string;
          hash: string;
          label: string;
          revoked_at: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          user_id: string;
          org_id: string;
          hash: string;
          label: string;
          revoked_at?: string | null;
          created_at?: string;
        };
        Update: {
          id?: string;
          user_id?: string;
          org_id?: string;
          hash?: string;
          label?: string;
          revoked_at?: string | null;
          created_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "mcp_tokens_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "mcp_tokens_user_id_fkey";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "users";
            referencedColumns: ["id"];
          },
        ];
      };
      members: {
        Row: {
          org_id: string;
          user_id: string;
          role: Database["public"]["Enums"]["member_role"];
          created_at: string;
        };
        Insert: {
          org_id: string;
          user_id: string;
          role: Database["public"]["Enums"]["member_role"];
          created_at?: string;
        };
        Update: {
          org_id?: string;
          user_id?: string;
          role?: Database["public"]["Enums"]["member_role"];
          created_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "members_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "members_user_id_fkey";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "users";
            referencedColumns: ["id"];
          },
        ];
      };
      notify_subscriptions: {
        Row: {
          sandbox_id: string;
          url: string;
          secret_enc: string;
          last_cursor: string | null;
          last_status: Database["public"]["Enums"]["notify_status"] | null;
          created_at: string;
        };
        Insert: {
          sandbox_id: string;
          url: string;
          secret_enc: string;
          last_cursor?: string | null;
          last_status?: Database["public"]["Enums"]["notify_status"] | null;
          created_at?: string;
        };
        Update: {
          sandbox_id?: string;
          url?: string;
          secret_enc?: string;
          last_cursor?: string | null;
          last_status?: Database["public"]["Enums"]["notify_status"] | null;
          created_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "notify_subscriptions_sandbox_id_fkey";
            columns: ["sandbox_id"];
            isOneToOne: true;
            referencedRelation: "sandboxes";
            referencedColumns: ["id"];
          },
        ];
      };
      orgs: {
        Row: {
          id: string;
          name: string;
          boat_api_key_enc: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          name: string;
          boat_api_key_enc?: string | null;
          created_at?: string;
        };
        Update: {
          id?: string;
          name?: string;
          boat_api_key_enc?: string | null;
          created_at?: string;
        };
        Relationships: [];
      };
      sandboxes: {
        Row: {
          id: string;
          boat_id: string;
          golden_id: string;
          org_id: string;
          owner_id: string;
          harness: Database["public"]["Enums"]["harness"];
          status: Database["public"]["Enums"]["sandbox_status"];
          conversation_ids: string[];
          created_at: string;
          stopped_at: string | null;
          deleted_at: string | null;
        };
        Insert: {
          id?: string;
          boat_id: string;
          golden_id: string;
          org_id: string;
          owner_id: string;
          harness: Database["public"]["Enums"]["harness"];
          status: Database["public"]["Enums"]["sandbox_status"];
          conversation_ids?: string[];
          created_at?: string;
          stopped_at?: string | null;
          deleted_at?: string | null;
        };
        Update: {
          id?: string;
          boat_id?: string;
          golden_id?: string;
          org_id?: string;
          owner_id?: string;
          harness?: Database["public"]["Enums"]["harness"];
          status?: Database["public"]["Enums"]["sandbox_status"];
          conversation_ids?: string[];
          created_at?: string;
          stopped_at?: string | null;
          deleted_at?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "sandboxes_golden_id_fkey";
            columns: ["golden_id"];
            isOneToOne: false;
            referencedRelation: "goldens";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "sandboxes_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "sandboxes_owner_id_fkey";
            columns: ["owner_id"];
            isOneToOne: false;
            referencedRelation: "users";
            referencedColumns: ["id"];
          },
        ];
      };
      service_tokens: {
        Row: {
          id: string;
          user_id: string;
          org_id: string;
          hash: string;
          label: string;
          revoked_at: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          user_id: string;
          org_id: string;
          hash: string;
          label: string;
          revoked_at?: string | null;
          created_at?: string;
        };
        Update: {
          id?: string;
          user_id?: string;
          org_id?: string;
          hash?: string;
          label?: string;
          revoked_at?: string | null;
          created_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "service_tokens_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "service_tokens_user_id_fkey";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "users";
            referencedColumns: ["id"];
          },
        ];
      };
    };
    Views: {
      [_ in never]: never;
    };
    Functions: {
      [_ in never]: never;
    };
    Enums: {
      credential_kind: "anthropic" | "openai" | "claude_oauth" | "boat";
      credential_scope: "user" | "org";
      harness: "claude" | "codex";
      member_role: "admin" | "member";
      notify_status: "finished" | "failed";
      sandbox_status: "starting" | "ready" | "running" | "stopping" | "stopped" | "failed" | "deleted";
      visibility: "org" | "private";
    };
    CompositeTypes: {
      [_ in never]: never;
    };
  };
};

export type Credential = Database["public"]["Tables"]["credentials"]["Row"];
export type Golden = Database["public"]["Tables"]["goldens"]["Row"];
export type McpToken = Database["public"]["Tables"]["mcp_tokens"]["Row"];
export type Member = Database["public"]["Tables"]["members"]["Row"];
export type NotifySubscription = Database["public"]["Tables"]["notify_subscriptions"]["Row"];
export type Org = Database["public"]["Tables"]["orgs"]["Row"];
export type Sandbox = Database["public"]["Tables"]["sandboxes"]["Row"];
export type ServiceToken = Database["public"]["Tables"]["service_tokens"]["Row"];
export type CredentialKind = Database["public"]["Enums"]["credential_kind"];
export type CredentialScope = Database["public"]["Enums"]["credential_scope"];
export type MemberRole = Database["public"]["Enums"]["member_role"];
export type NotifyStatus = Database["public"]["Enums"]["notify_status"];
export type SandboxStatus = Database["public"]["Enums"]["sandbox_status"];
