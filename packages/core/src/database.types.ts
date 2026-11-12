// Generated from supabase/migrations by `bun run db:types`. Do not edit.
import type { SandboxListMetadata } from "./sandbox-access.ts";

export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export type Database = {
  public: {
    Tables: {
      application_secret_uploads: {
        Row: {
          hash: string;
          actor_id: string;
          org_id: string;
          operation: string;
          target_id: string | null;
          expected_version: number | null;
          scope: string;
          name: string;
          value_enc: string;
          secret_expires_at: string | null;
          expires_at: string;
        };
        Insert: {
          hash: string;
          actor_id: string;
          org_id: string;
          operation: string;
          target_id?: string | null;
          expected_version?: number | null;
          scope: string;
          name: string;
          value_enc: string;
          secret_expires_at?: string | null;
          expires_at?: string;
        };
        Update: {
          hash?: string;
          actor_id?: string;
          org_id?: string;
          operation?: string;
          target_id?: string | null;
          expected_version?: number | null;
          scope?: string;
          name?: string;
          value_enc?: string;
          secret_expires_at?: string | null;
          expires_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "application_secret_uploads_actor_id_fkey";
            columns: ["actor_id"];
            isOneToOne: false;
            referencedRelation: "users";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "application_secret_uploads_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
        ];
      };
      application_secrets: {
        Row: {
          id: string;
          org_id: string;
          owner_id: string;
          scope: string;
          name: string;
          value_enc: string | null;
          version: number;
          epoch: number;
          status: string;
          expires_at: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          org_id: string;
          owner_id: string;
          scope: string;
          name: string;
          value_enc?: string | null;
          version?: number;
          epoch?: number;
          status?: string;
          expires_at?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          org_id?: string;
          owner_id?: string;
          scope?: string;
          name?: string;
          value_enc?: string | null;
          version?: number;
          epoch?: number;
          status?: string;
          expires_at?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "application_secrets_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "application_secrets_owner_id_fkey";
            columns: ["owner_id"];
            isOneToOne: false;
            referencedRelation: "users";
            referencedColumns: ["id"];
          },
        ];
      };
      application_vault_audit: {
        Row: {
          id: string;
          org_id: string;
          owner_id: string;
          scope: string;
          actor_id: string;
          resource_id: string;
          kind: string;
          operation: string;
          version: number;
          epoch: number;
          outcome: string;
          created_at: string;
        };
        Insert: {
          id?: string;
          org_id: string;
          owner_id: string;
          scope: string;
          actor_id: string;
          resource_id: string;
          kind: string;
          operation: string;
          version: number;
          epoch: number;
          outcome?: string;
          created_at?: string;
        };
        Update: {
          id?: string;
          org_id?: string;
          owner_id?: string;
          scope?: string;
          actor_id?: string;
          resource_id?: string;
          kind?: string;
          operation?: string;
          version?: number;
          epoch?: number;
          outcome?: string;
          created_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "application_vault_audit_actor_id_fkey";
            columns: ["actor_id"];
            isOneToOne: false;
            referencedRelation: "users";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "application_vault_audit_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "application_vault_audit_owner_id_fkey";
            columns: ["owner_id"];
            isOneToOne: false;
            referencedRelation: "users";
            referencedColumns: ["id"];
          },
        ];
      };
      armada_access_parents: {
        Row: {
          id: string;
          kind: string;
          org_id: string;
          owner_id: string;
          sandbox_id: string | null;
          state: string;
          authority_epoch: number;
          generation: number;
          golden_ids: string[];
          credential_ids: string[];
        };
        Insert: {
          id?: string;
          kind: string;
          org_id: string;
          owner_id: string;
          sandbox_id?: string | null;
          state: string;
          authority_epoch?: number;
          generation?: number;
          golden_ids?: string[];
          credential_ids?: string[];
        };
        Update: {
          id?: string;
          kind?: string;
          org_id?: string;
          owner_id?: string;
          sandbox_id?: string | null;
          state?: string;
          authority_epoch?: number;
          generation?: number;
          golden_ids?: string[];
          credential_ids?: string[];
        };
        Relationships: [
          {
            foreignKeyName: "armada_access_parents_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "armada_access_parents_owner_id_fkey";
            columns: ["owner_id"];
            isOneToOne: false;
            referencedRelation: "users";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "armada_access_parents_sandbox_id_fkey";
            columns: ["sandbox_id"];
            isOneToOne: true;
            referencedRelation: "sandboxes";
            referencedColumns: ["id"];
          },
        ];
      };
      credentials: {
        Row: {
          id: string;
          scope: Database["public"]["Enums"]["credential_scope"];
          owner_id: string;
          kind: Database["public"]["Enums"]["credential_kind"];
          value_enc: string;
          created_at: string;
          name: string;
          is_default: boolean;
          status: string;
          expires_at: string | null;
          updated_at: string;
          version: number;
        };
        Insert: {
          id?: string;
          scope: Database["public"]["Enums"]["credential_scope"];
          owner_id: string;
          kind: Database["public"]["Enums"]["credential_kind"];
          value_enc: string;
          created_at?: string;
          name?: string;
          is_default?: boolean;
          status?: string;
          expires_at?: string | null;
          updated_at?: string;
          version?: number;
        };
        Update: {
          id?: string;
          scope?: Database["public"]["Enums"]["credential_scope"];
          owner_id?: string;
          kind?: Database["public"]["Enums"]["credential_kind"];
          value_enc?: string;
          created_at?: string;
          name?: string;
          is_default?: boolean;
          status?: string;
          expires_at?: string | null;
          updated_at?: string;
          version?: number;
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
          connection_epoch: string;
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
          connection_epoch?: string;
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
          connection_epoch?: string;
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
      github_refresh_fences: {
        Row: {
          user_id: string;
          refresh_hash: string;
        };
        Insert: {
          user_id: string;
          refresh_hash: string;
        };
        Update: {
          user_id?: string;
          refresh_hash?: string;
        };
        Relationships: [
          {
            foreignKeyName: "github_refresh_fences_user_id_fkey";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "users";
            referencedColumns: ["id"];
          },
        ];
      };
      github_runtime_capabilities: {
        Row: {
          revision: number;
          hash: string;
          sandbox_id: string;
          binding: Json;
          expires_at: string;
        };
        Insert: {
          revision?: number;
          hash: string;
          sandbox_id: string;
          binding: Json;
          expires_at: string;
        };
        Update: {
          revision?: number;
          hash?: string;
          sandbox_id?: string;
          binding?: Json;
          expires_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "github_runtime_capabilities_sandbox_id_fkey";
            columns: ["sandbox_id"];
            isOneToOne: false;
            referencedRelation: "sandboxes";
            referencedColumns: ["id"];
          },
        ];
      };
      github_runtime_issued: {
        Row: {
          sandbox_id: string;
          owner_id: string;
          physical_generation: string;
          hash: string;
          token_enc: string;
        };
        Insert: {
          sandbox_id: string;
          owner_id: string;
          physical_generation: string;
          hash: string;
          token_enc: string;
        };
        Update: {
          sandbox_id?: string;
          owner_id?: string;
          physical_generation?: string;
          hash?: string;
          token_enc?: string;
        };
        Relationships: [
          {
            foreignKeyName: "github_runtime_issued_owner_id_fkey";
            columns: ["owner_id"];
            isOneToOne: false;
            referencedRelation: "users";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "github_runtime_issued_sandbox_id_fkey";
            columns: ["sandbox_id"];
            isOneToOne: false;
            referencedRelation: "sandboxes";
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
          expected_snapshot_id: string | null;
          revision_known: boolean;
          build_warnings: string[];
          failure_reason: string | null;
          legacy_payment_recovery_eligible: boolean;
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
          expected_snapshot_id?: string | null;
          revision_known?: boolean;
          build_warnings?: string[];
          failure_reason?: string | null;
          legacy_payment_recovery_eligible?: boolean;
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
          expected_snapshot_id?: string | null;
          revision_known?: boolean;
          build_warnings?: string[];
          failure_reason?: string | null;
          legacy_payment_recovery_eligible?: boolean;
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
          expected_snapshot_id: string | null;
          expected_sandbox_id: string | null;
          revision_known: boolean;
          operation_kind: string;
        };
        Insert: {
          id?: string;
          golden_id: string;
          owner_id?: string | null;
          created_at?: string;
          receipt?: Json | null;
          expected_snapshot_id?: string | null;
          expected_sandbox_id?: string | null;
          revision_known?: boolean;
          operation_kind?: string;
        };
        Update: {
          id?: string;
          golden_id?: string;
          owner_id?: string | null;
          created_at?: string;
          receipt?: Json | null;
          expected_snapshot_id?: string | null;
          expected_sandbox_id?: string | null;
          revision_known?: boolean;
          operation_kind?: string;
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
      golden_skill_defaults: {
        Row: {
          golden_id: string;
          skills: Json;
          updated_at: string;
        };
        Insert: {
          golden_id: string;
          skills: Json;
          updated_at?: string;
        };
        Update: {
          golden_id?: string;
          skills?: Json;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "golden_skill_defaults_golden_id_fkey";
            columns: ["golden_id"];
            isOneToOne: true;
            referencedRelation: "goldens";
            referencedColumns: ["id"];
          },
        ];
      };
      golden_snapshot_publications: {
        Row: {
          id: string;
          golden_id: string;
          provider: string;
          backend_id: string;
          proven: boolean;
          snapshot: string;
          source_id: string | null;
          artifact_id: string | null;
          authority: Json | null;
          target: Json;
          manager_id: string;
          job_id: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          golden_id: string;
          provider: string;
          backend_id: string;
          proven?: boolean;
          snapshot: string;
          source_id?: string | null;
          artifact_id?: string | null;
          authority?: Json | null;
          target: Json;
          manager_id: string;
          job_id?: string | null;
          created_at?: string;
        };
        Update: {
          id?: string;
          golden_id?: string;
          provider?: string;
          backend_id?: string;
          proven?: boolean;
          snapshot?: string;
          source_id?: string | null;
          artifact_id?: string | null;
          authority?: Json | null;
          target?: Json;
          manager_id?: string;
          job_id?: string | null;
          created_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "golden_snapshot_publications_golden_id_fkey";
            columns: ["golden_id"];
            isOneToOne: false;
            referencedRelation: "goldens";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "golden_snapshot_publications_job_id_fkey";
            columns: ["job_id"];
            isOneToOne: false;
            referencedRelation: "golden_build_jobs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "golden_snapshot_publications_manager_id_fkey";
            columns: ["manager_id"];
            isOneToOne: false;
            referencedRelation: "users";
            referencedColumns: ["id"];
          },
        ];
      };
      golden_snapshot_retirements: {
        Row: {
          id: string;
          golden_id: string;
          provider: string;
          backend_id: string;
          old_snapshot: string;
          new_snapshot: string;
          publication_id: string;
          replacement_id: string;
          state: string;
          sealed: boolean;
          delete_started: boolean;
          claim_id: string | null;
          claim_until: string | null;
          attempts: number;
          review_receipt: string | null;
          reviewed_by: string | null;
          reason: string | null;
          next_attempt_at: string;
          created_at: string;
        };
        Insert: {
          id?: string;
          golden_id: string;
          provider: string;
          backend_id: string;
          old_snapshot: string;
          new_snapshot: string;
          publication_id: string;
          replacement_id: string;
          state?: string;
          sealed?: boolean;
          delete_started?: boolean;
          claim_id?: string | null;
          claim_until?: string | null;
          attempts?: number;
          review_receipt?: string | null;
          reviewed_by?: string | null;
          reason?: string | null;
          next_attempt_at?: string;
          created_at?: string;
        };
        Update: {
          id?: string;
          golden_id?: string;
          provider?: string;
          backend_id?: string;
          old_snapshot?: string;
          new_snapshot?: string;
          publication_id?: string;
          replacement_id?: string;
          state?: string;
          sealed?: boolean;
          delete_started?: boolean;
          claim_id?: string | null;
          claim_until?: string | null;
          attempts?: number;
          review_receipt?: string | null;
          reviewed_by?: string | null;
          reason?: string | null;
          next_attempt_at?: string;
          created_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "golden_snapshot_retirements_golden_id_fkey";
            columns: ["golden_id"];
            isOneToOne: false;
            referencedRelation: "goldens";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "golden_snapshot_retirements_publication_id_fkey";
            columns: ["publication_id"];
            isOneToOne: false;
            referencedRelation: "golden_snapshot_publications";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "golden_snapshot_retirements_replacement_id_fkey";
            columns: ["replacement_id"];
            isOneToOne: false;
            referencedRelation: "golden_snapshot_publications";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "golden_snapshot_retirements_reviewed_by_fkey";
            columns: ["reviewed_by"];
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
          size_policy: Json | null;
          build_warnings: string[];
          helper_receipt: Json | null;
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
          size_policy?: Json | null;
          build_warnings?: string[];
          helper_receipt?: Json | null;
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
          size_policy?: Json | null;
          build_warnings?: string[];
          helper_receipt?: Json | null;
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
      launch_template_revisions: {
        Row: {
          id: string;
          template_id: string;
          revision: number;
          definition: Json;
          digest: string;
          created_by: string;
          created_at: string;
        };
        Insert: {
          id?: string;
          template_id: string;
          revision: number;
          definition: Json;
          digest: string;
          created_by: string;
          created_at?: string;
        };
        Update: {
          id?: string;
          template_id?: string;
          revision?: number;
          definition?: Json;
          digest?: string;
          created_by?: string;
          created_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "launch_template_revisions_created_by_fkey";
            columns: ["created_by"];
            isOneToOne: false;
            referencedRelation: "users";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "launch_template_revisions_template_id_fkey";
            columns: ["template_id"];
            isOneToOne: false;
            referencedRelation: "launch_templates";
            referencedColumns: ["id"];
          },
        ];
      };
      launch_templates: {
        Row: {
          id: string;
          org_id: string;
          owner_id: string;
          scope: string;
          name: string;
          current_revision: number;
          status: string;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          org_id: string;
          owner_id: string;
          scope: string;
          name: string;
          current_revision?: number;
          status?: string;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          org_id?: string;
          owner_id?: string;
          scope?: string;
          name?: string;
          current_revision?: number;
          status?: string;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "launch_templates_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "launch_templates_owner_id_fkey";
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
          credential_id: string | null;
          credential_version: number | null;
        };
        Insert: {
          scope: string;
          machine_id: string;
          github_enabled?: boolean;
          harness: string;
          credential_id?: string | null;
          credential_version?: number | null;
        };
        Update: {
          scope?: string;
          machine_id?: string;
          github_enabled?: boolean;
          harness?: string;
          credential_id?: string | null;
          credential_version?: number | null;
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
      orchestrator_activity: {
        Row: {
          orchestrator_id: string;
          sandbox_id: string;
          parent_generation: number;
          event_id: string;
          prompt_id: string;
          conversation_id: string;
          observed_at: string;
        };
        Insert: {
          orchestrator_id: string;
          sandbox_id: string;
          parent_generation: number;
          event_id: string;
          prompt_id: string;
          conversation_id: string;
          observed_at: string;
        };
        Update: {
          orchestrator_id?: string;
          sandbox_id?: string;
          parent_generation?: number;
          event_id?: string;
          prompt_id?: string;
          conversation_id?: string;
          observed_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "orchestrator_activity_orchestrator_id_fkey";
            columns: ["orchestrator_id"];
            isOneToOne: false;
            referencedRelation: "orchestrators";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "orchestrator_activity_sandbox_id_fkey";
            columns: ["sandbox_id"];
            isOneToOne: false;
            referencedRelation: "sandboxes";
            referencedColumns: ["id"];
          },
        ];
      };
      orchestrator_child_operations: {
        Row: {
          id: string;
          orchestrator_id: string;
          owner_id: string;
          org_id: string;
          parent_generation: number;
          parent_epoch: number;
          action: string;
          target_id: string;
          scope_target: string;
          idempotency_key: string;
          request_digest: string;
          state: string;
          dispatched_at: string | null;
          reconcile_after: string;
          reconcile_lease: string | null;
          reconcile_until: string | null;
          provider_sandbox_id: string | null;
          error_code: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          orchestrator_id: string;
          owner_id: string;
          org_id: string;
          parent_generation: number;
          parent_epoch: number;
          action: string;
          target_id: string;
          scope_target: string;
          idempotency_key: string;
          request_digest: string;
          state?: string;
          dispatched_at?: string | null;
          reconcile_after?: string;
          reconcile_lease?: string | null;
          reconcile_until?: string | null;
          provider_sandbox_id?: string | null;
          error_code?: string | null;
          created_at?: string;
        };
        Update: {
          id?: string;
          orchestrator_id?: string;
          owner_id?: string;
          org_id?: string;
          parent_generation?: number;
          parent_epoch?: number;
          action?: string;
          target_id?: string;
          scope_target?: string;
          idempotency_key?: string;
          request_digest?: string;
          state?: string;
          dispatched_at?: string | null;
          reconcile_after?: string;
          reconcile_lease?: string | null;
          reconcile_until?: string | null;
          provider_sandbox_id?: string | null;
          error_code?: string | null;
          created_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "orchestrator_child_operations_orchestrator_id_org_id_owner_fkey";
            columns: ["orchestrator_id", "org_id", "owner_id"];
            isOneToOne: false;
            referencedRelation: "armada_access_parents";
            referencedColumns: ["id", "org_id", "owner_id"];
          },
          {
            foreignKeyName: "orchestrator_child_operations_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "orchestrator_child_operations_owner_id_fkey";
            columns: ["owner_id"];
            isOneToOne: false;
            referencedRelation: "users";
            referencedColumns: ["id"];
          },
        ];
      };
      orchestrator_children: {
        Row: {
          sandbox_id: string;
          orchestrator_id: string;
          org_id: string;
          owner_id: string;
        };
        Insert: {
          sandbox_id: string;
          orchestrator_id: string;
          org_id: string;
          owner_id: string;
        };
        Update: {
          sandbox_id?: string;
          orchestrator_id?: string;
          org_id?: string;
          owner_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "orchestrator_children_orchestrator_id_org_id_owner_id_fkey";
            columns: ["orchestrator_id", "org_id", "owner_id"];
            isOneToOne: false;
            referencedRelation: "armada_access_parents";
            referencedColumns: ["id", "org_id", "owner_id"];
          },
          {
            foreignKeyName: "orchestrator_children_sandbox_id_fkey";
            columns: ["sandbox_id"];
            isOneToOne: true;
            referencedRelation: "sandboxes";
            referencedColumns: ["id"];
          },
        ];
      };
      orchestrator_delegations: {
        Row: {
          id: string;
          orchestrator_id: string;
          hash: string;
          epoch: number;
          physical_generation: number;
          scopes: string[];
          golden_ids: string[];
          account_ids: string[];
          created_at: string;
          expires_at: string;
          acknowledged_at: string | null;
          revoked_at: string | null;
          native_generation: string | null;
        };
        Insert: {
          id?: string;
          orchestrator_id: string;
          hash: string;
          epoch: number;
          physical_generation: number;
          scopes: string[];
          golden_ids: string[];
          account_ids: string[];
          created_at?: string;
          expires_at: string;
          acknowledged_at?: string | null;
          revoked_at?: string | null;
          native_generation?: string | null;
        };
        Update: {
          id?: string;
          orchestrator_id?: string;
          hash?: string;
          epoch?: number;
          physical_generation?: number;
          scopes?: string[];
          golden_ids?: string[];
          account_ids?: string[];
          created_at?: string;
          expires_at?: string;
          acknowledged_at?: string | null;
          revoked_at?: string | null;
          native_generation?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "orchestrator_delegations_orchestrator_id_fkey";
            columns: ["orchestrator_id"];
            isOneToOne: false;
            referencedRelation: "armada_access_parents";
            referencedColumns: ["id"];
          },
        ];
      };
      orchestrator_lifecycle: {
        Row: {
          orchestrator_id: string;
          idle_seconds: number;
          max_active_children: number | null;
          last_activity_at: string;
          observation_state: string;
          observation_generation: number | null;
          observation_evidence: string | null;
          observed_at: string | null;
          reconcile_after: string;
          lease: string | null;
          lease_until: string | null;
          stop_operation_id: string | null;
          stop_generation: number | null;
          stop_physical_generation: string | null;
          stop_sandbox_id: string | null;
          stop_provider_sandbox_id: string | null;
          stop_reason: string | null;
          stop_dispatched: boolean;
          reason: string;
        };
        Insert: {
          orchestrator_id: string;
          idle_seconds?: number;
          max_active_children?: number | null;
          last_activity_at?: string;
          observation_state?: string;
          observation_generation?: number | null;
          observation_evidence?: string | null;
          observed_at?: string | null;
          reconcile_after?: string;
          lease?: string | null;
          lease_until?: string | null;
          stop_operation_id?: string | null;
          stop_generation?: number | null;
          stop_physical_generation?: string | null;
          stop_sandbox_id?: string | null;
          stop_provider_sandbox_id?: string | null;
          stop_reason?: string | null;
          stop_dispatched?: boolean;
          reason?: string;
        };
        Update: {
          orchestrator_id?: string;
          idle_seconds?: number;
          max_active_children?: number | null;
          last_activity_at?: string;
          observation_state?: string;
          observation_generation?: number | null;
          observation_evidence?: string | null;
          observed_at?: string | null;
          reconcile_after?: string;
          lease?: string | null;
          lease_until?: string | null;
          stop_operation_id?: string | null;
          stop_generation?: number | null;
          stop_physical_generation?: string | null;
          stop_sandbox_id?: string | null;
          stop_provider_sandbox_id?: string | null;
          stop_reason?: string | null;
          stop_dispatched?: boolean;
          reason?: string;
        };
        Relationships: [
          {
            foreignKeyName: "orchestrator_lifecycle_orchestrator_id_fkey";
            columns: ["orchestrator_id"];
            isOneToOne: true;
            referencedRelation: "armada_access_parents";
            referencedColumns: ["id"];
          },
        ];
      };
      orchestrator_lifecycle_mutations: {
        Row: {
          id: string;
          orchestrator_id: string;
          actor_id: string;
          action: string;
          target: string;
          idempotency_key: string;
          request_digest: string;
          result: Json;
        };
        Insert: {
          id?: string;
          orchestrator_id: string;
          actor_id: string;
          action: string;
          target: string;
          idempotency_key: string;
          request_digest: string;
          result: Json;
        };
        Update: {
          id?: string;
          orchestrator_id?: string;
          actor_id?: string;
          action?: string;
          target?: string;
          idempotency_key?: string;
          request_digest?: string;
          result?: Json;
        };
        Relationships: [
          {
            foreignKeyName: "orchestrator_lifecycle_mutations_actor_id_fkey";
            columns: ["actor_id"];
            isOneToOne: false;
            referencedRelation: "users";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "orchestrator_lifecycle_mutations_orchestrator_id_fkey";
            columns: ["orchestrator_id"];
            isOneToOne: false;
            referencedRelation: "orchestrators";
            referencedColumns: ["id"];
          },
        ];
      };
      orchestrator_operations: {
        Row: {
          id: string;
          orchestrator_id: string;
          actor_id: string;
          action: string;
          idempotency_key: string;
          request_digest: string;
          revision: number;
          state: string;
          error_code: string | null;
          runtime_result: Json | null;
        };
        Insert: {
          id?: string;
          orchestrator_id: string;
          actor_id: string;
          action: string;
          idempotency_key: string;
          request_digest: string;
          revision: number;
          state?: string;
          error_code?: string | null;
          runtime_result?: Json | null;
        };
        Update: {
          id?: string;
          orchestrator_id?: string;
          actor_id?: string;
          action?: string;
          idempotency_key?: string;
          request_digest?: string;
          revision?: number;
          state?: string;
          error_code?: string | null;
          runtime_result?: Json | null;
        };
        Relationships: [
          {
            foreignKeyName: "orchestrator_operations_actor_id_fkey";
            columns: ["actor_id"];
            isOneToOne: false;
            referencedRelation: "users";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "orchestrator_operations_orchestrator_id_fkey";
            columns: ["orchestrator_id"];
            isOneToOne: false;
            referencedRelation: "orchestrators";
            referencedColumns: ["id"];
          },
        ];
      };
      orchestrator_runtime: {
        Row: {
          orchestrator_id: string;
          configuration: Json;
          skill_revision: string;
          conversation_id: string | null;
          checkpoint: Json | null;
          provider_cursor: string | null;
          continuity: string;
          updated_at: string;
          last_activity_at: string;
          idle_deadline: string | null;
          blocked_reason: string | null;
          created_at: string;
          skill_receipt: Json | null;
          mcp_wrapper_revision: string | null;
        };
        Insert: {
          orchestrator_id: string;
          configuration: Json;
          skill_revision: string;
          conversation_id?: string | null;
          checkpoint?: Json | null;
          provider_cursor?: string | null;
          continuity?: string;
          updated_at?: string;
          last_activity_at?: string;
          idle_deadline?: string | null;
          blocked_reason?: string | null;
          created_at?: string;
          skill_receipt?: Json | null;
          mcp_wrapper_revision?: string | null;
        };
        Update: {
          orchestrator_id?: string;
          configuration?: Json;
          skill_revision?: string;
          conversation_id?: string | null;
          checkpoint?: Json | null;
          provider_cursor?: string | null;
          continuity?: string;
          updated_at?: string;
          last_activity_at?: string;
          idle_deadline?: string | null;
          blocked_reason?: string | null;
          created_at?: string;
          skill_receipt?: Json | null;
          mcp_wrapper_revision?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "orchestrator_runtime_orchestrator_id_fkey";
            columns: ["orchestrator_id"];
            isOneToOne: true;
            referencedRelation: "orchestrators";
            referencedColumns: ["id"];
          },
        ];
      };
      orchestrator_runtime_create_keys: {
        Row: {
          owner_id: string;
          org_id: string;
          idempotency_key: string;
          request_digest: string;
          orchestrator_id: string;
        };
        Insert: {
          owner_id: string;
          org_id: string;
          idempotency_key: string;
          request_digest: string;
          orchestrator_id: string;
        };
        Update: {
          owner_id?: string;
          org_id?: string;
          idempotency_key?: string;
          request_digest?: string;
          orchestrator_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "orchestrator_runtime_create_keys_orchestrator_id_fkey";
            columns: ["orchestrator_id"];
            isOneToOne: false;
            referencedRelation: "orchestrators";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "orchestrator_runtime_create_keys_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "orchestrator_runtime_create_keys_owner_id_fkey";
            columns: ["owner_id"];
            isOneToOne: false;
            referencedRelation: "users";
            referencedColumns: ["id"];
          },
        ];
      };
      orchestrator_runtime_events: {
        Row: {
          sequence: number;
          orchestrator_id: string;
          revision: number;
          generation: number | null;
          conversation_id: string | null;
          upstream_id: string | null;
          event: Json;
          created_at: string;
        };
        Insert: {
          sequence: number;
          orchestrator_id: string;
          revision: number;
          generation?: number | null;
          conversation_id?: string | null;
          upstream_id?: string | null;
          event: Json;
          created_at?: string;
        };
        Update: {
          sequence?: number;
          orchestrator_id?: string;
          revision?: number;
          generation?: number | null;
          conversation_id?: string | null;
          upstream_id?: string | null;
          event?: Json;
          created_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "orchestrator_runtime_events_orchestrator_id_fkey";
            columns: ["orchestrator_id"];
            isOneToOne: false;
            referencedRelation: "orchestrators";
            referencedColumns: ["id"];
          },
        ];
      };
      orchestrator_waits: {
        Row: {
          id: string;
          orchestrator_id: string;
          parent_generation: number;
          kind: string;
          reference: string;
          reason: string;
          evidence: string;
          evidence_at: string;
          expires_at: string;
          deadline: string;
          created_at: string;
          released_at: string | null;
        };
        Insert: {
          id?: string;
          orchestrator_id: string;
          parent_generation: number;
          kind: string;
          reference: string;
          reason: string;
          evidence: string;
          evidence_at: string;
          expires_at: string;
          deadline: string;
          created_at: string;
          released_at?: string | null;
        };
        Update: {
          id?: string;
          orchestrator_id?: string;
          parent_generation?: number;
          kind?: string;
          reference?: string;
          reason?: string;
          evidence?: string;
          evidence_at?: string;
          expires_at?: string;
          deadline?: string;
          created_at?: string;
          released_at?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "orchestrator_waits_orchestrator_id_fkey";
            columns: ["orchestrator_id"];
            isOneToOne: false;
            referencedRelation: "orchestrators";
            referencedColumns: ["id"];
          },
        ];
      };
      orchestrators: {
        Row: {
          id: string;
          org_id: string;
          owner_id: string;
          sandbox_id: string | null;
          state: string;
          revision: number;
          authority_epoch: number;
          created_at: string;
        };
        Insert: {
          id?: string;
          org_id: string;
          owner_id: string;
          sandbox_id?: string | null;
          state?: string;
          revision?: number;
          authority_epoch?: number;
          created_at?: string;
        };
        Update: {
          id?: string;
          org_id?: string;
          owner_id?: string;
          sandbox_id?: string | null;
          state?: string;
          revision?: number;
          authority_epoch?: number;
          created_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "orchestrators_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "orchestrators_owner_id_fkey";
            columns: ["owner_id"];
            isOneToOne: false;
            referencedRelation: "users";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "orchestrators_sandbox_id_fkey";
            columns: ["sandbox_id"];
            isOneToOne: true;
            referencedRelation: "sandboxes";
            referencedColumns: ["id"];
          },
        ];
      };
      org_skill_defaults: {
        Row: {
          org_id: string;
          skills: Json;
          updated_at: string;
        };
        Insert: {
          org_id: string;
          skills: Json;
          updated_at?: string;
        };
        Update: {
          org_id?: string;
          skills?: Json;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "org_skill_defaults_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: true;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
        ];
      };
      organization_invitations: {
        Row: {
          id: string;
          org_id: string;
          email: string;
          role: Database["public"]["Enums"]["member_role"];
          hash: string;
          expires_at: string;
          status: string;
          delivery: string;
          token_enc: string | null;
          attempts: number;
          lease_until: string | null;
          updated_at: string;
          created_at: string;
        };
        Insert: {
          id?: string;
          org_id: string;
          email: string;
          role: Database["public"]["Enums"]["member_role"];
          hash: string;
          expires_at: string;
          status?: string;
          delivery: string;
          token_enc?: string | null;
          attempts?: number;
          lease_until?: string | null;
          updated_at?: string;
          created_at?: string;
        };
        Update: {
          id?: string;
          org_id?: string;
          email?: string;
          role?: Database["public"]["Enums"]["member_role"];
          hash?: string;
          expires_at?: string;
          status?: string;
          delivery?: string;
          token_enc?: string | null;
          attempts?: number;
          lease_until?: string | null;
          updated_at?: string;
          created_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "organization_invitations_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
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
      personal_skill_defaults: {
        Row: {
          user_id: string;
          skills: Json;
          updated_at: string;
        };
        Insert: {
          user_id: string;
          skills: Json;
          updated_at?: string;
        };
        Update: {
          user_id?: string;
          skills?: Json;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "personal_skill_defaults_user_id_fkey";
            columns: ["user_id"];
            isOneToOne: true;
            referencedRelation: "users";
            referencedColumns: ["id"];
          },
        ];
      };
      readable_variables: {
        Row: {
          id: string;
          org_id: string;
          owner_id: string;
          scope: string;
          name: string;
          value: string | null;
          version: number;
          epoch: number;
          status: string;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          org_id: string;
          owner_id: string;
          scope: string;
          name: string;
          value?: string | null;
          version?: number;
          epoch?: number;
          status?: string;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          org_id?: string;
          owner_id?: string;
          scope?: string;
          name?: string;
          value?: string | null;
          version?: number;
          epoch?: number;
          status?: string;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "readable_variables_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "readable_variables_owner_id_fkey";
            columns: ["owner_id"];
            isOneToOne: false;
            referencedRelation: "users";
            referencedColumns: ["id"];
          },
        ];
      };
      resource_observations: {
        Row: {
          id: number;
          sandbox_id: string;
          admission_claim_id: string;
          physical_id: string;
          generation: string;
          boot_id: string;
          uptime_ms: number;
          observed_at: string;
          observation: Json;
        };
        Insert: {
          id: number;
          sandbox_id: string;
          admission_claim_id: string;
          physical_id: string;
          generation: string;
          boot_id: string;
          uptime_ms: number;
          observed_at: string;
          observation: Json;
        };
        Update: {
          id?: number;
          sandbox_id?: string;
          admission_claim_id?: string;
          physical_id?: string;
          generation?: string;
          boot_id?: string;
          uptime_ms?: number;
          observed_at?: string;
          observation?: Json;
        };
        Relationships: [
          {
            foreignKeyName: "resource_observations_sandbox_id_fkey";
            columns: ["sandbox_id"];
            isOneToOne: false;
            referencedRelation: "sandboxes";
            referencedColumns: ["id"];
          },
        ];
      };
      routine_run_inputs: {
        Row: {
          run_id: string;
          template_id: string;
          template_revision: number;
          prompt: string;
          ttl_seconds: number;
        };
        Insert: {
          run_id: string;
          template_id: string;
          template_revision: number;
          prompt: string;
          ttl_seconds: number;
        };
        Update: {
          run_id?: string;
          template_id?: string;
          template_revision?: number;
          prompt?: string;
          ttl_seconds?: number;
        };
        Relationships: [
          {
            foreignKeyName: "routine_run_inputs_run_id_fkey";
            columns: ["run_id"];
            isOneToOne: true;
            referencedRelation: "routine_runs";
            referencedColumns: ["id"];
          },
        ];
      };
      routine_runs: {
        Row: {
          id: string;
          routine_id: string;
          org_id: string;
          owner_id: string;
          scheduled_due_at: string;
          configuration_version: number;
          state: string;
          reason: string | null;
          request_key: string;
          template_request_id: string | null;
          prompt_id: string | null;
          conversation_id: string | null;
          task_state: string | null;
          task_checked_at: string | null;
          task_check_id: string | null;
          sandbox_id: string | null;
          missed_intervals: number;
          lease_id: string | null;
          lease_until: string | null;
          created_at: string;
          updated_at: string;
          missed_count_capped: boolean;
        };
        Insert: {
          id?: string;
          routine_id: string;
          org_id: string;
          owner_id: string;
          scheduled_due_at: string;
          configuration_version: number;
          state: string;
          reason?: string | null;
          request_key: string;
          template_request_id?: string | null;
          prompt_id?: string | null;
          conversation_id?: string | null;
          task_state?: string | null;
          task_checked_at?: string | null;
          task_check_id?: string | null;
          sandbox_id?: string | null;
          missed_intervals?: number;
          lease_id?: string | null;
          lease_until?: string | null;
          created_at?: string;
          updated_at?: string;
          missed_count_capped?: boolean;
        };
        Update: {
          id?: string;
          routine_id?: string;
          org_id?: string;
          owner_id?: string;
          scheduled_due_at?: string;
          configuration_version?: number;
          state?: string;
          reason?: string | null;
          request_key?: string;
          template_request_id?: string | null;
          prompt_id?: string | null;
          conversation_id?: string | null;
          task_state?: string | null;
          task_checked_at?: string | null;
          task_check_id?: string | null;
          sandbox_id?: string | null;
          missed_intervals?: number;
          lease_id?: string | null;
          lease_until?: string | null;
          created_at?: string;
          updated_at?: string;
          missed_count_capped?: boolean;
        };
        Relationships: [
          {
            foreignKeyName: "routine_runs_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "routine_runs_owner_id_fkey";
            columns: ["owner_id"];
            isOneToOne: false;
            referencedRelation: "users";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "routine_runs_routine_id_fkey";
            columns: ["routine_id"];
            isOneToOne: false;
            referencedRelation: "routines";
            referencedColumns: ["id"];
          },
        ];
      };
      routines: {
        Row: {
          id: string;
          org_id: string;
          owner_id: string;
          scope: string;
          name: string;
          template_id: string;
          template_revision: number;
          prompt: string;
          interval_hours: number | null;
          max_runs_per_day: number;
          ttl_seconds: number;
          status: string;
          version: number;
          created_at: string;
          updated_at: string;
          next_due_at: string | null;
          consecutive_failures: number;
          pause_reason: string | null;
          cron: string | null;
          timezone: string;
        };
        Insert: {
          id?: string;
          org_id: string;
          owner_id: string;
          scope: string;
          name: string;
          template_id: string;
          template_revision: number;
          prompt: string;
          interval_hours?: number | null;
          max_runs_per_day: number;
          ttl_seconds: number;
          status?: string;
          version?: number;
          created_at?: string;
          updated_at?: string;
          next_due_at?: string | null;
          consecutive_failures?: number;
          pause_reason?: string | null;
          cron?: string | null;
          timezone?: string;
        };
        Update: {
          id?: string;
          org_id?: string;
          owner_id?: string;
          scope?: string;
          name?: string;
          template_id?: string;
          template_revision?: number;
          prompt?: string;
          interval_hours?: number | null;
          max_runs_per_day?: number;
          ttl_seconds?: number;
          status?: string;
          version?: number;
          created_at?: string;
          updated_at?: string;
          next_due_at?: string | null;
          consecutive_failures?: number;
          pause_reason?: string | null;
          cron?: string | null;
          timezone?: string;
        };
        Relationships: [
          {
            foreignKeyName: "routines_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "routines_owner_id_fkey";
            columns: ["owner_id"];
            isOneToOne: false;
            referencedRelation: "users";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "routines_template_id_template_revision_fkey";
            columns: ["template_id", "template_revision"];
            isOneToOne: false;
            referencedRelation: "launch_template_revisions";
            referencedColumns: ["template_id", "revision"];
          },
        ];
      };
      runtime_commands: {
        Row: {
          sandbox_id: string;
          request_id: string;
          sequence: number;
          epoch: number;
          request_enc: string;
          result_enc: string | null;
        };
        Insert: {
          sandbox_id: string;
          request_id: string;
          sequence: number;
          epoch: number;
          request_enc: string;
          result_enc?: string | null;
        };
        Update: {
          sandbox_id?: string;
          request_id?: string;
          sequence?: number;
          epoch?: number;
          request_enc?: string;
          result_enc?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "runtime_commands_sandbox_id_fkey";
            columns: ["sandbox_id"];
            isOneToOne: false;
            referencedRelation: "sandboxes";
            referencedColumns: ["id"];
          },
        ];
      };
      runtime_enrolments: {
        Row: {
          sandbox_id: string;
          lifecycle_generation: number;
          epoch: number;
          enrolment_hash: string | null;
          enrolment_expires_at: string | null;
          configuration_enc: string | null;
          runtime_hash: string | null;
        };
        Insert: {
          sandbox_id: string;
          lifecycle_generation: number;
          epoch?: number;
          enrolment_hash?: string | null;
          enrolment_expires_at?: string | null;
          configuration_enc?: string | null;
          runtime_hash?: string | null;
        };
        Update: {
          sandbox_id?: string;
          lifecycle_generation?: number;
          epoch?: number;
          enrolment_hash?: string | null;
          enrolment_expires_at?: string | null;
          configuration_enc?: string | null;
          runtime_hash?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "runtime_enrolments_sandbox_id_fkey";
            columns: ["sandbox_id"];
            isOneToOne: true;
            referencedRelation: "sandboxes";
            referencedColumns: ["id"];
          },
        ];
      };
      sandbox_turn_models: {
        Row: {
          sandbox_id: string;
          prompt_id: string;
          requested_model: string | null;
          evidence: Json | null;
        };
        Insert: {
          sandbox_id: string;
          prompt_id: string;
          requested_model?: string | null;
          evidence?: Json | null;
        };
        Update: {
          sandbox_id?: string;
          prompt_id?: string;
          requested_model?: string | null;
          evidence?: Json | null;
        };
        Relationships: [
          {
            foreignKeyName: "sandbox_turn_models_sandbox_id_fkey";
            columns: ["sandbox_id"];
            isOneToOne: false;
            referencedRelation: "sandboxes";
            referencedColumns: ["id"];
          },
        ];
      };
      sandbox_work_recovery: {
        Row: {
          id: string;
          sandbox_id: string;
          archive_enc: string;
          created_at: string;
        };
        Insert: {
          id?: string;
          sandbox_id: string;
          archive_enc: string;
          created_at?: string;
        };
        Update: {
          id?: string;
          sandbox_id?: string;
          archive_enc?: string;
          created_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "sandbox_work_recovery_sandbox_id_fkey";
            columns: ["sandbox_id"];
            isOneToOne: false;
            referencedRelation: "sandboxes";
            referencedColumns: ["id"];
          },
        ];
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
          credential_id: string | null;
          credential_version: number | null;
          machine_size: Json | null;
          resource_project: Json | null;
          resource_sampling_claim_id: string | null;
          resource_sampling_after: string | null;
          resource_sampling_generation: number | null;
          orchestrator_native_generation: string | null;
          task_outcome: Json | null;
          task_prompt_id: string | null;
          preservation_note: string | null;
          usage_runtime_seconds: number | null;
          usage_running_since: string | null;
          usage_turns: Json | null;
          skills: Json;
          stop_generation: number;
          preservation_stop_generation: number | null;
          application_secret_tainted: boolean;
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
          credential_id?: string | null;
          credential_version?: number | null;
          machine_size?: Json | null;
          resource_project?: Json | null;
          resource_sampling_claim_id?: string | null;
          resource_sampling_after?: string | null;
          resource_sampling_generation?: number | null;
          orchestrator_native_generation?: string | null;
          task_outcome?: Json | null;
          task_prompt_id?: string | null;
          preservation_note?: string | null;
          usage_runtime_seconds?: number | null;
          usage_running_since?: string | null;
          usage_turns?: Json | null;
          skills?: Json;
          stop_generation?: number;
          preservation_stop_generation?: number | null;
          application_secret_tainted?: boolean;
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
          credential_id?: string | null;
          credential_version?: number | null;
          machine_size?: Json | null;
          resource_project?: Json | null;
          resource_sampling_claim_id?: string | null;
          resource_sampling_after?: string | null;
          resource_sampling_generation?: number | null;
          orchestrator_native_generation?: string | null;
          task_outcome?: Json | null;
          task_prompt_id?: string | null;
          preservation_note?: string | null;
          usage_runtime_seconds?: number | null;
          usage_running_since?: string | null;
          usage_turns?: Json | null;
          skills?: Json;
          stop_generation?: number;
          preservation_stop_generation?: number | null;
          application_secret_tainted?: boolean;
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
      template_launch_requests: {
        Row: {
          id: string;
          org_id: string;
          actor_id: string;
          client_key: string;
          digest: string;
          template_id: string;
          revision_id: string;
          manifest: Json;
          golden_operation_fence_id: string;
          sandbox_id: string;
          state: string;
          result: Json | null;
          reason: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          org_id: string;
          actor_id: string;
          client_key: string;
          digest: string;
          template_id: string;
          revision_id: string;
          manifest: Json;
          golden_operation_fence_id: string;
          sandbox_id: string;
          state?: string;
          result?: Json | null;
          reason?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          org_id?: string;
          actor_id?: string;
          client_key?: string;
          digest?: string;
          template_id?: string;
          revision_id?: string;
          manifest?: Json;
          golden_operation_fence_id?: string;
          sandbox_id?: string;
          state?: string;
          result?: Json | null;
          reason?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "template_launch_requests_actor_id_fkey";
            columns: ["actor_id"];
            isOneToOne: false;
            referencedRelation: "users";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "template_launch_requests_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "template_launch_requests_revision_id_fkey";
            columns: ["revision_id"];
            isOneToOne: false;
            referencedRelation: "launch_template_revisions";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "template_launch_requests_template_id_fkey";
            columns: ["template_id"];
            isOneToOne: false;
            referencedRelation: "launch_templates";
            referencedColumns: ["id"];
          },
        ];
      };
    };
    Views: {
      [_ in never]: never;
    };
    Functions: {
      sandbox_list_metadata: { Args: Record<string, never>; Returns: SandboxListMetadata[] };
      can_open_sandbox: { Args: { target_org: string; target_owner: string }; Returns: boolean };
    };
    Enums: {
      credential_kind: "anthropic" | "openai" | "claude_oauth" | "boat" | "codex_auth" | "modal" | "skillpack";
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

export type ApplicationSecretUploadRow = Database["public"]["Tables"]["application_secret_uploads"]["Row"];
export type ApplicationSecretRow = Database["public"]["Tables"]["application_secrets"]["Row"];
export type ApplicationVaultAuditRow = Database["public"]["Tables"]["application_vault_audit"]["Row"];
export type ArmadaAccessParentRow = Database["public"]["Tables"]["armada_access_parents"]["Row"];
export type Credential = Database["public"]["Tables"]["credentials"]["Row"];
export type GitHubAuthorization = Database["public"]["Tables"]["github_authorizations"]["Row"];
export type GitHubConnection = Database["public"]["Tables"]["github_connections"]["Row"];
export type GitHubRefreshFence = Database["public"]["Tables"]["github_refresh_fences"]["Row"];
export type GitHubRuntimeCapability = Database["public"]["Tables"]["github_runtime_capabilities"]["Row"];
export type GitHubRuntimeIssued = Database["public"]["Tables"]["github_runtime_issued"]["Row"];
export type GoldenAdoptionReceipt = Database["public"]["Tables"]["golden_adoption_receipts"]["Row"];
export type GoldenBackendSlot = Database["public"]["Tables"]["golden_backend_slots"]["Row"];
export type GoldenBuildJob = Database["public"]["Tables"]["golden_build_jobs"]["Row"];
export type GoldenOperationFence = Database["public"]["Tables"]["golden_operation_fences"]["Row"];
export type GoldenSkillDefaultsRow = Database["public"]["Tables"]["golden_skill_defaults"]["Row"];
export type GoldenSnapshotPublication = Database["public"]["Tables"]["golden_snapshot_publications"]["Row"];
export type GoldenSnapshotRetirement = Database["public"]["Tables"]["golden_snapshot_retirements"]["Row"];
export type Golden = Database["public"]["Tables"]["goldens"]["Row"];
export type LaunchTemplateRevisionRow = Database["public"]["Tables"]["launch_template_revisions"]["Row"];
export type LaunchTemplateRow = Database["public"]["Tables"]["launch_templates"]["Row"];
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
export type OrchestratorActivity = Database["public"]["Tables"]["orchestrator_activity"]["Row"];
export type OrchestratorChildOperation = Database["public"]["Tables"]["orchestrator_child_operations"]["Row"];
export type OrchestratorChildRow = Database["public"]["Tables"]["orchestrator_children"]["Row"];
export type OrchestratorDelegationRow = Database["public"]["Tables"]["orchestrator_delegations"]["Row"];
export type OrchestratorLifecycle = Database["public"]["Tables"]["orchestrator_lifecycle"]["Row"];
export type OrchestratorLifecycleMutation = Database["public"]["Tables"]["orchestrator_lifecycle_mutations"]["Row"];
export type OrchestratorOperationRow = Database["public"]["Tables"]["orchestrator_operations"]["Row"];
export type OrchestratorRuntimeRow = Database["public"]["Tables"]["orchestrator_runtime"]["Row"];
export type OrchestratorRuntimeCreateKeyRow = Database["public"]["Tables"]["orchestrator_runtime_create_keys"]["Row"];
export type OrchestratorRuntimeEventRow = Database["public"]["Tables"]["orchestrator_runtime_events"]["Row"];
export type OrchestratorWait = Database["public"]["Tables"]["orchestrator_waits"]["Row"];
export type OrchestratorIdentityRow = Database["public"]["Tables"]["orchestrators"]["Row"];
export type OrgSkillDefaultsRow = Database["public"]["Tables"]["org_skill_defaults"]["Row"];
export type OrganizationInvitationRow = Database["public"]["Tables"]["organization_invitations"]["Row"];
export type Org = Database["public"]["Tables"]["orgs"]["Row"];
export type PersonalSkillDefaultsRow = Database["public"]["Tables"]["personal_skill_defaults"]["Row"];
export type ReadableVariableRow = Database["public"]["Tables"]["readable_variables"]["Row"];
export type ResourceObservation = Database["public"]["Tables"]["resource_observations"]["Row"];
export type RoutineRunInputRow = Database["public"]["Tables"]["routine_run_inputs"]["Row"];
export type RoutineRunRow = Database["public"]["Tables"]["routine_runs"]["Row"];
export type RoutineRow = Database["public"]["Tables"]["routines"]["Row"];
export type RuntimeCommandRow = Database["public"]["Tables"]["runtime_commands"]["Row"];
export type RuntimeEnrolmentRow = Database["public"]["Tables"]["runtime_enrolments"]["Row"];
export type SandboxTurnModelRow = Database["public"]["Tables"]["sandbox_turn_models"]["Row"];
export type SandboxWorkRecovery = Database["public"]["Tables"]["sandbox_work_recovery"]["Row"];
export type Sandbox = Database["public"]["Tables"]["sandboxes"]["Row"];
export type ServiceToken = Database["public"]["Tables"]["service_tokens"]["Row"];
export type TemplateLaunchRequestRow = Database["public"]["Tables"]["template_launch_requests"]["Row"];
export type CredentialKind = Database["public"]["Enums"]["credential_kind"];
export type CredentialScope = Database["public"]["Enums"]["credential_scope"];
export type MemberRole = Database["public"]["Enums"]["member_role"];
export type NotifyStatus = Database["public"]["Enums"]["notify_status"];
export type SandboxStatus = Database["public"]["Enums"]["sandbox_status"];
