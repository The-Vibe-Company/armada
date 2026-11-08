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
      github_connections: {
        Row: {
          user_id: string;
          github_id: number;
          login: string;
          name: string | null;
          refresh_token_enc: string;
          refresh_expires_at: string | null;
          revoked_at: string | null;
          created_at: string;
          updated_at: string;
          installations: Json | null;
          access_token_enc: string | null;
          access_expires_at: string | null;
        };
        Insert: {
          user_id: string;
          github_id: number;
          login: string;
          name?: string | null;
          refresh_token_enc: string;
          refresh_expires_at?: string | null;
          revoked_at?: string | null;
          created_at?: string;
          updated_at?: string;
          installations?: Json | null;
          access_token_enc?: string | null;
          access_expires_at?: string | null;
        };
        Update: {
          user_id?: string;
          github_id?: number;
          login?: string;
          name?: string | null;
          refresh_token_enc?: string;
          refresh_expires_at?: string | null;
          revoked_at?: string | null;
          created_at?: string;
          updated_at?: string;
          installations?: Json | null;
          access_token_enc?: string | null;
          access_expires_at?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "github_connections_user_id_fkey";
            columns: ["user_id"];
            isOneToOne: true;
            referencedRelation: "users";
            referencedColumns: ["id"];
          },
        ];
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
          boat_sandbox_id: string | null;
          provider: Database["public"]["Enums"]["sandbox_provider"];
          provider_sandbox_id: string | null;
          provider_snapshot_id: string | null;
          modal_workspace: string | null;
          modal_environment: string | null;
          modal_app_id: string | null;
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
          boat_sandbox_id?: string | null;
          provider?: Database["public"]["Enums"]["sandbox_provider"];
          provider_sandbox_id?: string | null;
          provider_snapshot_id?: string | null;
          modal_workspace?: string | null;
          modal_environment?: string | null;
          modal_app_id?: string | null;
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
          boat_sandbox_id?: string | null;
          provider?: Database["public"]["Enums"]["sandbox_provider"];
          provider_sandbox_id?: string | null;
          provider_snapshot_id?: string | null;
          modal_workspace?: string | null;
          modal_environment?: string | null;
          modal_app_id?: string | null;
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
      oauth_clients: {
        Row: {
          id: string;
          name: string;
          redirect_uris: string[];
          created_at: string;
        };
        Insert: {
          id: string;
          name: string;
          redirect_uris: string[];
          created_at?: string;
        };
        Update: {
          id?: string;
          name?: string;
          redirect_uris?: string[];
          created_at?: string;
        };
        Relationships: [];
      };
      oauth_codes: {
        Row: {
          hash: string;
          client_id: string;
          redirect_uri: string;
          code_challenge: string;
          user_id: string;
          org_id: string;
          expires_at: string;
          used_at: string | null;
          created_at: string;
        };
        Insert: {
          hash: string;
          client_id: string;
          redirect_uri: string;
          code_challenge: string;
          user_id: string;
          org_id: string;
          expires_at: string;
          used_at?: string | null;
          created_at?: string;
        };
        Update: {
          hash?: string;
          client_id?: string;
          redirect_uri?: string;
          code_challenge?: string;
          user_id?: string;
          org_id?: string;
          expires_at?: string;
          used_at?: string | null;
          created_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "oauth_codes_client_id_fkey";
            columns: ["client_id"];
            isOneToOne: false;
            referencedRelation: "oauth_clients";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "oauth_codes_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "oauth_codes_user_id_fkey";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "users";
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
          boat_id: string | null;
          golden_id: string;
          org_id: string;
          owner_id: string;
          harness: Database["public"]["Enums"]["harness"];
          status: Database["public"]["Enums"]["sandbox_status"];
          conversation_ids: string[];
          created_at: string;
          stopped_at: string | null;
          deleted_at: string | null;
          status_reason: string | null;
          model: string | null;
          reasoning_effort: string | null;
          provider: Database["public"]["Enums"]["sandbox_provider"];
          provider_sandbox_id: string;
        };
        Insert: {
          id?: string;
          boat_id?: string | null;
          golden_id: string;
          org_id: string;
          owner_id: string;
          harness: Database["public"]["Enums"]["harness"];
          status: Database["public"]["Enums"]["sandbox_status"];
          conversation_ids?: string[];
          created_at?: string;
          stopped_at?: string | null;
          deleted_at?: string | null;
          status_reason?: string | null;
          model?: string | null;
          reasoning_effort?: string | null;
          provider: Database["public"]["Enums"]["sandbox_provider"];
          provider_sandbox_id: string;
        };
        Update: {
          id?: string;
          boat_id?: string | null;
          golden_id?: string;
          org_id?: string;
          owner_id?: string;
          harness?: Database["public"]["Enums"]["harness"];
          status?: Database["public"]["Enums"]["sandbox_status"];
          conversation_ids?: string[];
          created_at?: string;
          stopped_at?: string | null;
          deleted_at?: string | null;
          status_reason?: string | null;
          model?: string | null;
          reasoning_effort?: string | null;
          provider?: Database["public"]["Enums"]["sandbox_provider"];
          provider_sandbox_id?: string;
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
      credential_kind: "anthropic" | "openai" | "claude_oauth" | "boat" | "codex_auth" | "modal";
      credential_scope: "user" | "org";
      harness: "claude" | "codex";
      member_role: "admin" | "member";
      notify_status: "finished" | "failed";
      sandbox_provider: "boat" | "modal";
      sandbox_status: "starting" | "ready" | "running" | "stopping" | "stopped" | "failed" | "deleted";
      visibility: "org" | "private";
    };
    CompositeTypes: {
      [_ in never]: never;
    };
  };
};

export type Credential = Database["public"]["Tables"]["credentials"]["Row"];
export type GitHubConnection = Database["public"]["Tables"]["github_connections"]["Row"];
export type Golden = Database["public"]["Tables"]["goldens"]["Row"];
export type McpToken = Database["public"]["Tables"]["mcp_tokens"]["Row"];
export type Member = Database["public"]["Tables"]["members"]["Row"];
export type NotifySubscription = Database["public"]["Tables"]["notify_subscriptions"]["Row"];
export type OAuthClient = Database["public"]["Tables"]["oauth_clients"]["Row"];
export type OAuthCode = Database["public"]["Tables"]["oauth_codes"]["Row"];
export type Org = Database["public"]["Tables"]["orgs"]["Row"];
export type Sandbox = Database["public"]["Tables"]["sandboxes"]["Row"];
export type ServiceToken = Database["public"]["Tables"]["service_tokens"]["Row"];
export type CredentialKind = Database["public"]["Enums"]["credential_kind"];
export type CredentialScope = Database["public"]["Enums"]["credential_scope"];
export type MemberRole = Database["public"]["Enums"]["member_role"];
export type NotifyStatus = Database["public"]["Enums"]["notify_status"];
export type SandboxStatus = Database["public"]["Enums"]["sandbox_status"];
