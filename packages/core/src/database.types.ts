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
      github_authorizations: {
        Row: {
          id: string;
          user_id: string;
          state_hash: string;
          status: string;
          expires_at: string;
        };
        Insert: {
          id: string;
          user_id: string;
          state_hash: string;
          status: string;
          expires_at: string;
        };
        Update: {
          id?: string;
          user_id?: string;
          state_hash?: string;
          status?: string;
          expires_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "github_authorizations_user_id_fkey";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "users";
            referencedColumns: ["id"];
          },
        ];
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
      golden_adoption_receipts: {
        Row: {
          id: string;
          user_id: string;
          golden_id: string;
          backend_id: string;
          acl: Json;
          snapshot_id: string;
          sandbox_id: string;
          expires_at: string;
        };
        Insert: {
          id?: string;
          user_id: string;
          golden_id: string;
          backend_id: string;
          acl: Json;
          snapshot_id: string;
          sandbox_id: string;
          expires_at?: string;
        };
        Update: {
          id?: string;
          user_id?: string;
          golden_id?: string;
          backend_id?: string;
          acl?: Json;
          snapshot_id?: string;
          sandbox_id?: string;
          expires_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "golden_adoption_receipts_golden_id_fkey";
            columns: ["golden_id"];
            isOneToOne: false;
            referencedRelation: "goldens";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "golden_adoption_receipts_user_id_fkey";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "users";
            referencedColumns: ["id"];
          },
        ];
      };
      golden_backend_slots: {
        Row: {
          id: string;
          provider: string;
          backend_id: string;
          max_goldens: number;
          org_id: string;
          owner_id: string;
          golden_id: string | null;
          build_id: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          provider: string;
          backend_id: string;
          max_goldens: number;
          org_id: string;
          owner_id: string;
          golden_id?: string | null;
          build_id?: string | null;
          created_at?: string;
        };
        Update: {
          id?: string;
          provider?: string;
          backend_id?: string;
          max_goldens?: number;
          org_id?: string;
          owner_id?: string;
          golden_id?: string | null;
          build_id?: string | null;
          created_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "golden_backend_slots_golden_id_fkey";
            columns: ["golden_id"];
            isOneToOne: false;
            referencedRelation: "goldens";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "golden_backend_slots_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "golden_backend_slots_owner_id_fkey";
            columns: ["owner_id"];
            isOneToOne: false;
            referencedRelation: "users";
            referencedColumns: ["id"];
          },
        ];
      };
      golden_build_jobs: {
        Row: {
          id: string;
          org_id: string;
          owner_id: string;
          name: string;
          visibility: string;
          idempotency_key: string;
          request_hash: string;
          payload_enc: string;
          reservation_id: string | null;
          state: string;
          phase: string;
          fence: string | null;
          lease_until: string | null;
          deadline: string | null;
          builder_id: string | null;
          snapshot: string | null;
          golden_id: string | null;
          error_code: string | null;
          created_at: string;
          updated_at: string;
          provider: Database["public"]["Enums"]["sandbox_provider"];
        };
        Insert: {
          id: string;
          org_id: string;
          owner_id: string;
          name: string;
          visibility: string;
          idempotency_key: string;
          request_hash: string;
          payload_enc: string;
          reservation_id?: string | null;
          state?: string;
          phase?: string;
          fence?: string | null;
          lease_until?: string | null;
          deadline?: string | null;
          builder_id?: string | null;
          snapshot?: string | null;
          golden_id?: string | null;
          error_code?: string | null;
          created_at?: string;
          updated_at?: string;
          provider?: Database["public"]["Enums"]["sandbox_provider"];
        };
        Update: {
          id?: string;
          org_id?: string;
          owner_id?: string;
          name?: string;
          visibility?: string;
          idempotency_key?: string;
          request_hash?: string;
          payload_enc?: string;
          reservation_id?: string | null;
          state?: string;
          phase?: string;
          fence?: string | null;
          lease_until?: string | null;
          deadline?: string | null;
          builder_id?: string | null;
          snapshot?: string | null;
          golden_id?: string | null;
          error_code?: string | null;
          created_at?: string;
          updated_at?: string;
          provider?: Database["public"]["Enums"]["sandbox_provider"];
        };
        Relationships: [
          {
            foreignKeyName: "golden_build_jobs_golden_id_fkey";
            columns: ["golden_id"];
            isOneToOne: false;
            referencedRelation: "goldens";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "golden_build_jobs_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "golden_build_jobs_owner_id_fkey";
            columns: ["owner_id"];
            isOneToOne: false;
            referencedRelation: "users";
            referencedColumns: ["id"];
          },
        ];
      };
      golden_operation_fences: {
        Row: {
          id: string;
          golden_id: string;
          owner_id: string | null;
          created_at: string;
          receipt: Json | null;
        };
        Insert: {
          id?: string;
          golden_id: string;
          owner_id?: string | null;
          created_at?: string;
          receipt?: Json | null;
        };
        Update: {
          id?: string;
          golden_id?: string;
          owner_id?: string | null;
          created_at?: string;
          receipt?: Json | null;
        };
        Relationships: [
          {
            foreignKeyName: "golden_operation_fences_golden_id_fkey";
            columns: ["golden_id"];
            isOneToOne: false;
            referencedRelation: "goldens";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "golden_operation_fences_owner_id_fkey";
            columns: ["owner_id"];
            isOneToOne: false;
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
          removed_at: string | null;
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
          removed_at?: string | null;
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
          removed_at?: string | null;
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
      mcp_actor_epochs: {
        Row: {
          org_id: string;
          user_id: string;
          epoch: number;
        };
        Insert: {
          org_id: string;
          user_id: string;
          epoch?: number;
        };
        Update: {
          org_id?: string;
          user_id?: string;
          epoch?: number;
        };
        Relationships: [
          {
            foreignKeyName: "mcp_actor_epochs_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "mcp_actor_epochs_user_id_fkey";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "users";
            referencedColumns: ["id"];
          },
        ];
      };
      mcp_bindings: {
        Row: {
          sandbox_id: string;
          connection_id: string;
          grant_id: string;
        };
        Insert: {
          sandbox_id: string;
          connection_id: string;
          grant_id: string;
        };
        Update: {
          sandbox_id?: string;
          connection_id?: string;
          grant_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "mcp_bindings_connection_id_fkey";
            columns: ["connection_id"];
            isOneToOne: false;
            referencedRelation: "mcp_connections";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "mcp_bindings_grant_id_fkey";
            columns: ["grant_id"];
            isOneToOne: false;
            referencedRelation: "mcp_grants";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "mcp_bindings_sandbox_id_fkey";
            columns: ["sandbox_id"];
            isOneToOne: false;
            referencedRelation: "sandboxes";
            referencedColumns: ["id"];
          },
        ];
      };
      mcp_bootstraps: {
        Row: {
          sandbox_id: string;
          physical_generation: string;
          revision: string;
          configured: boolean;
        };
        Insert: {
          sandbox_id: string;
          physical_generation: string;
          revision: string;
          configured?: boolean;
        };
        Update: {
          sandbox_id?: string;
          physical_generation?: string;
          revision?: string;
          configured?: boolean;
        };
        Relationships: [
          {
            foreignKeyName: "mcp_bootstraps_sandbox_id_fkey";
            columns: ["sandbox_id"];
            isOneToOne: true;
            referencedRelation: "sandboxes";
            referencedColumns: ["id"];
          },
        ];
      };
      mcp_connections: {
        Row: {
          id: string;
          org_id: string;
          owner_id: string;
          scope: string;
          name: string;
          transport: string;
          url: string | null;
          command: string | null;
          args: Json;
          auth_type: string;
          disabled: boolean;
          created_at: string;
          catalog_id: string | null;
          default_for_launch: boolean;
        };
        Insert: {
          id?: string;
          org_id: string;
          owner_id: string;
          scope: string;
          name: string;
          transport: string;
          url?: string | null;
          command?: string | null;
          args?: Json;
          auth_type: string;
          disabled?: boolean;
          created_at?: string;
          catalog_id?: string | null;
          default_for_launch?: boolean;
        };
        Update: {
          id?: string;
          org_id?: string;
          owner_id?: string;
          scope?: string;
          name?: string;
          transport?: string;
          url?: string | null;
          command?: string | null;
          args?: Json;
          auth_type?: string;
          disabled?: boolean;
          created_at?: string;
          catalog_id?: string | null;
          default_for_launch?: boolean;
        };
        Relationships: [
          {
            foreignKeyName: "mcp_connections_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "mcp_connections_owner_id_fkey";
            columns: ["owner_id"];
            isOneToOne: false;
            referencedRelation: "users";
            referencedColumns: ["id"];
          },
        ];
      };
      mcp_grants: {
        Row: {
          id: string;
          connection_id: string;
          value_enc: string | null;
          generation: number;
          version: number;
          status: string;
          account_label: string | null;
          revoked_at: string | null;
          refresh_owner: string | null;
          refresh_until: string | null;
          refresh_consumed: boolean;
        };
        Insert: {
          id?: string;
          connection_id: string;
          value_enc?: string | null;
          generation?: number;
          version?: number;
          status?: string;
          account_label?: string | null;
          revoked_at?: string | null;
          refresh_owner?: string | null;
          refresh_until?: string | null;
          refresh_consumed?: boolean;
        };
        Update: {
          id?: string;
          connection_id?: string;
          value_enc?: string | null;
          generation?: number;
          version?: number;
          status?: string;
          account_label?: string | null;
          revoked_at?: string | null;
          refresh_owner?: string | null;
          refresh_until?: string | null;
          refresh_consumed?: boolean;
        };
        Relationships: [
          {
            foreignKeyName: "mcp_grants_connection_id_fkey";
            columns: ["connection_id"];
            isOneToOne: true;
            referencedRelation: "mcp_connections";
            referencedColumns: ["id"];
          },
        ];
      };
      mcp_invalidation_deliveries: {
        Row: {
          replica_id: string;
          event_id: number;
        };
        Insert: {
          replica_id: string;
          event_id: number;
        };
        Update: {
          replica_id?: string;
          event_id?: number;
        };
        Relationships: [
          {
            foreignKeyName: "mcp_invalidation_deliveries_event_id_fkey";
            columns: ["event_id"];
            isOneToOne: false;
            referencedRelation: "mcp_invalidations";
            referencedColumns: ["id"];
          },
        ];
      };
      mcp_invalidations: {
        Row: {
          id: number;
          connection_id: string | null;
          sandbox_id: string | null;
          org_id: string;
          generation: number | null;
          reason: string;
          created_at: string;
        };
        Insert: {
          id: number;
          connection_id?: string | null;
          sandbox_id?: string | null;
          org_id: string;
          generation?: number | null;
          reason: string;
          created_at?: string;
        };
        Update: {
          id?: number;
          connection_id?: string | null;
          sandbox_id?: string | null;
          org_id?: string;
          generation?: number | null;
          reason?: string;
          created_at?: string;
        };
        Relationships: [];
      };
      mcp_leases: {
        Row: {
          id: string;
          sandbox_id: string;
          connection_id: string;
          grant_id: string;
          org_id: string;
          owner_id: string;
          generation: number;
          sandbox_generation: number;
          hash: string;
          operations: string[];
          expires_at: string;
          revoked_at: string | null;
        };
        Insert: {
          id?: string;
          sandbox_id: string;
          connection_id: string;
          grant_id: string;
          org_id: string;
          owner_id: string;
          generation: number;
          sandbox_generation: number;
          hash: string;
          operations: string[];
          expires_at: string;
          revoked_at?: string | null;
        };
        Update: {
          id?: string;
          sandbox_id?: string;
          connection_id?: string;
          grant_id?: string;
          org_id?: string;
          owner_id?: string;
          generation?: number;
          sandbox_generation?: number;
          hash?: string;
          operations?: string[];
          expires_at?: string;
          revoked_at?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "mcp_leases_grant_id_fkey";
            columns: ["grant_id"];
            isOneToOne: false;
            referencedRelation: "mcp_grants";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "mcp_leases_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "mcp_leases_owner_id_fkey";
            columns: ["owner_id"];
            isOneToOne: false;
            referencedRelation: "users";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "mcp_leases_sandbox_id_connection_id_fkey";
            columns: ["sandbox_id", "connection_id"];
            isOneToOne: false;
            referencedRelation: "mcp_bindings";
            referencedColumns: ["sandbox_id", "connection_id"];
          },
        ];
      };
      mcp_pending_oauth: {
        Row: {
          hash: string;
          actor_id: string;
          connection_id: string;
          org_id: string;
          generation: number;
          expires_at: string;
          payload_enc: string;
        };
        Insert: {
          hash: string;
          actor_id: string;
          connection_id: string;
          org_id: string;
          generation: number;
          expires_at: string;
          payload_enc: string;
        };
        Update: {
          hash?: string;
          actor_id?: string;
          connection_id?: string;
          org_id?: string;
          generation?: number;
          expires_at?: string;
          payload_enc?: string;
        };
        Relationships: [
          {
            foreignKeyName: "mcp_pending_oauth_actor_id_fkey";
            columns: ["actor_id"];
            isOneToOne: false;
            referencedRelation: "users";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "mcp_pending_oauth_connection_id_fkey";
            columns: ["connection_id"];
            isOneToOne: false;
            referencedRelation: "mcp_connections";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "mcp_pending_oauth_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
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
      modal_events: {
        Row: {
          cursor: number;
          scope: string;
          sandbox_id: string;
          generation: string;
          producer_sequence: number;
          event: Json;
        };
        Insert: {
          cursor: number;
          scope: string;
          sandbox_id: string;
          generation: string;
          producer_sequence: number;
          event: Json;
        };
        Update: {
          cursor?: number;
          scope?: string;
          sandbox_id?: string;
          generation?: string;
          producer_sequence?: number;
          event?: Json;
        };
        Relationships: [
          {
            foreignKeyName: "modal_events_scope_sandbox_id_fkey";
            columns: ["scope", "sandbox_id"];
            isOneToOne: false;
            referencedRelation: "modal_machines";
            referencedColumns: ["scope", "id"];
          },
        ];
      };
      modal_images: {
        Row: {
          scope: string;
          name: string;
          source_id: string;
          record: Json;
        };
        Insert: {
          scope: string;
          name: string;
          source_id: string;
          record: Json;
        };
        Update: {
          scope?: string;
          name?: string;
          source_id?: string;
          record?: Json;
        };
        Relationships: [
          {
            foreignKeyName: "modal_images_scope_source_id_fkey";
            columns: ["scope", "source_id"];
            isOneToOne: false;
            referencedRelation: "modal_machines";
            referencedColumns: ["scope", "id"];
          },
        ];
      };
      modal_machines: {
        Row: {
          scope: string;
          org_id: string;
          owner_id: string;
          visibility: Database["public"]["Enums"]["visibility"];
          id: string;
          request_key: string;
          record: Json;
          lease_id: string | null;
          lease_until: string | null;
        };
        Insert: {
          scope: string;
          org_id: string;
          owner_id: string;
          visibility: Database["public"]["Enums"]["visibility"];
          id: string;
          request_key: string;
          record: Json;
          lease_id?: string | null;
          lease_until?: string | null;
        };
        Update: {
          scope?: string;
          org_id?: string;
          owner_id?: string;
          visibility?: Database["public"]["Enums"]["visibility"];
          id?: string;
          request_key?: string;
          record?: Json;
          lease_id?: string | null;
          lease_until?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "modal_machines_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "modal_machines_owner_id_fkey";
            columns: ["owner_id"];
            isOneToOne: false;
            referencedRelation: "users";
            referencedColumns: ["id"];
          },
        ];
      };
      modal_server_apps: {
        Row: {
          org_id: string;
          authority: string;
          authority_scope: string;
          authority_owner_id: string;
          app_name: string;
          app_id: string;
          environment: string;
        };
        Insert: {
          org_id: string;
          authority: string;
          authority_scope: string;
          authority_owner_id: string;
          app_name: string;
          app_id: string;
          environment: string;
        };
        Update: {
          org_id?: string;
          authority?: string;
          authority_scope?: string;
          authority_owner_id?: string;
          app_name?: string;
          app_id?: string;
          environment?: string;
        };
        Relationships: [
          {
            foreignKeyName: "modal_server_apps_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
        ];
      };
      modal_server_harnesses: {
        Row: {
          scope: string;
          machine_id: string;
          github_enabled: boolean;
          harness: string;
        };
        Insert: {
          scope: string;
          machine_id: string;
          github_enabled?: boolean;
          harness: string;
        };
        Update: {
          scope?: string;
          machine_id?: string;
          github_enabled?: boolean;
          harness?: string;
        };
        Relationships: [
          {
            foreignKeyName: "modal_server_harnesses_scope_fkey";
            columns: ["scope"];
            isOneToOne: false;
            referencedRelation: "modal_server_scopes";
            referencedColumns: ["scope"];
          },
        ];
      };
      modal_server_scopes: {
        Row: {
          scope: string;
          context: Json;
        };
        Insert: {
          scope: string;
          context: Json;
        };
        Update: {
          scope?: string;
          context?: Json;
        };
        Relationships: [];
      };
      model_auth_ownership: {
        Row: {
          account_id: string;
          account_version: number;
          sandbox_id: string;
          assigned_at: string;
        };
        Insert: {
          account_id: string;
          account_version: number;
          sandbox_id: string;
          assigned_at?: string;
        };
        Update: {
          account_id?: string;
          account_version?: number;
          sandbox_id?: string;
          assigned_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "model_auth_ownership_account_id_fkey";
            columns: ["account_id"];
            isOneToOne: true;
            referencedRelation: "credentials";
            referencedColumns: ["id"];
          },
        ];
      };
      model_auth_state: {
        Row: {
          account_id: string;
          account_version: number;
          auth_revision: number;
          state_enc: string;
          source_generation: string;
          updated_at: string;
        };
        Insert: {
          account_id: string;
          account_version: number;
          auth_revision?: number;
          state_enc: string;
          source_generation: string;
          updated_at?: string;
        };
        Update: {
          account_id?: string;
          account_version?: number;
          auth_revision?: number;
          state_enc?: string;
          source_generation?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "model_auth_state_account_id_fkey";
            columns: ["account_id"];
            isOneToOne: false;
            referencedRelation: "credentials";
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
          visibility: Database["public"]["Enums"]["visibility"];
          source_golden_visibility: Database["public"]["Enums"]["visibility"];
          access_owner_id: string;
          mcp_generation: number;
          repository_dir: string | null;
          requested_ttl_seconds: number | null;
          effective_ttl_seconds: number;
          expires_at: string;
          lifecycle_generation: number;
          last_observed_at: string | null;
          lifecycle_error: string | null;
          reconcile_after: string;
          stop_requested_at: string | null;
          activity_lease_id: string | null;
          activity_until: string | null;
          reconcile_lease: string | null;
          reconcile_lease_until: string | null;
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
          visibility: Database["public"]["Enums"]["visibility"];
          source_golden_visibility: Database["public"]["Enums"]["visibility"];
          access_owner_id: string;
          mcp_generation?: number;
          repository_dir?: string | null;
          requested_ttl_seconds?: number | null;
          effective_ttl_seconds?: number;
          expires_at?: string;
          lifecycle_generation?: number;
          last_observed_at?: string | null;
          lifecycle_error?: string | null;
          reconcile_after?: string;
          stop_requested_at?: string | null;
          activity_lease_id?: string | null;
          activity_until?: string | null;
          reconcile_lease?: string | null;
          reconcile_lease_until?: string | null;
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
          visibility?: Database["public"]["Enums"]["visibility"];
          source_golden_visibility?: Database["public"]["Enums"]["visibility"];
          access_owner_id?: string;
          mcp_generation?: number;
          repository_dir?: string | null;
          requested_ttl_seconds?: number | null;
          effective_ttl_seconds?: number;
          expires_at?: string;
          lifecycle_generation?: number;
          last_observed_at?: string | null;
          lifecycle_error?: string | null;
          reconcile_after?: string;
          stop_requested_at?: string | null;
          activity_lease_id?: string | null;
          activity_until?: string | null;
          reconcile_lease?: string | null;
          reconcile_lease_until?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "sandboxes_access_owner_id_fkey";
            columns: ["access_owner_id"];
            isOneToOne: false;
            referencedRelation: "users";
            referencedColumns: ["id"];
          },
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
export type GitHubAuthorization = Database["public"]["Tables"]["github_authorizations"]["Row"];
export type GitHubConnection = Database["public"]["Tables"]["github_connections"]["Row"];
export type GoldenAdoptionReceipt = Database["public"]["Tables"]["golden_adoption_receipts"]["Row"];
export type GoldenBackendSlot = Database["public"]["Tables"]["golden_backend_slots"]["Row"];
export type GoldenBuildJob = Database["public"]["Tables"]["golden_build_jobs"]["Row"];
export type GoldenOperationFence = Database["public"]["Tables"]["golden_operation_fences"]["Row"];
export type Golden = Database["public"]["Tables"]["goldens"]["Row"];
export type McpActorEpoch = Database["public"]["Tables"]["mcp_actor_epochs"]["Row"];
export type McpBinding = Database["public"]["Tables"]["mcp_bindings"]["Row"];
export type McpBootstrapReceipt = Database["public"]["Tables"]["mcp_bootstraps"]["Row"];
export type McpConnection = Database["public"]["Tables"]["mcp_connections"]["Row"];
export type McpGrant = Database["public"]["Tables"]["mcp_grants"]["Row"];
export type McpInvalidationDelivery = Database["public"]["Tables"]["mcp_invalidation_deliveries"]["Row"];
export type McpInvalidationEvent = Database["public"]["Tables"]["mcp_invalidations"]["Row"];
export type McpLease = Database["public"]["Tables"]["mcp_leases"]["Row"];
export type McpPendingOAuth = Database["public"]["Tables"]["mcp_pending_oauth"]["Row"];
export type McpToken = Database["public"]["Tables"]["mcp_tokens"]["Row"];
export type Member = Database["public"]["Tables"]["members"]["Row"];
export type ModalEventRow = Database["public"]["Tables"]["modal_events"]["Row"];
export type ModalImageRow = Database["public"]["Tables"]["modal_images"]["Row"];
export type ModalMachineRow = Database["public"]["Tables"]["modal_machines"]["Row"];
export type ModalServerAppRow = Database["public"]["Tables"]["modal_server_apps"]["Row"];
export type ModalServerHarnessRow = Database["public"]["Tables"]["modal_server_harnesses"]["Row"];
export type ModalServerScopeRow = Database["public"]["Tables"]["modal_server_scopes"]["Row"];
export type ModelAuthOwnershipRow = Database["public"]["Tables"]["model_auth_ownership"]["Row"];
export type ModelAuthStateRow = Database["public"]["Tables"]["model_auth_state"]["Row"];
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
