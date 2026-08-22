/**
 * Minimal generated-equivalent Supabase schema for the scan history boundary.
 *
 * The production schema generator is not part of this repository, so this
 * checked-in contract keeps the persistence adapter typed and reproducible in
 * local, CI, and deployment environments. Regenerate this file from the
 * authoritative Supabase schema when the scan_history table changes.
 */

export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[]

export type Database = {
  public: {
    Tables: {
      profiles: {
        Row: {
          user_id: string
          tier: string
        }
        Insert: {
          user_id?: string
          tier?: string
        }
        Update: {
          user_id?: string
          tier?: string
        }
        Relationships: []
      }
      conversations: {
        Row: {
          id: string
          user_id: string
          title: string
          pinned: boolean
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          user_id?: string
          title?: string
          pinned?: boolean
          created_at?: string
          updated_at?: string
        }
        Update: {
          id?: string
          user_id?: string
          title?: string
          pinned?: boolean
          created_at?: string
          updated_at?: string
        }
        Relationships: []
      }
      messages: {
        Row: {
          id: string
          conversation_id: string
          user_id: string
          content: string
          role: string
          created_at: string
        }
        Insert: {
          id?: string
          conversation_id?: string
          user_id?: string
          content?: string
          role?: string
          created_at?: string
        }
        Update: {
          id?: string
          conversation_id?: string
          user_id?: string
          content?: string
          role?: string
          created_at?: string
        }
        Relationships: []
      }
      scan_history: {
        Row: {
          id: string
          project_id: string
          user_id: string
          created_at: string
          execution_profile_used: string
          active_plugins: Json
          model_config_used: Json
          ast_context: Json
          scan_size_bytes: number
          files_scanned_count: number
          skipped_files_count: number
          findings_list: Json
          overall_risk: string
          performance: Json
          swarm_execution_data: Json | null
        }
        Insert: {
          id?: string
          project_id?: string
          user_id?: string
          created_at?: string
          execution_profile_used?: string
          active_plugins?: Json
          model_config_used?: Json
          ast_context?: Json
          scan_size_bytes?: number
          files_scanned_count?: number
          skipped_files_count?: number
          findings_list?: Json
          overall_risk?: string
          performance?: Json
          swarm_execution_data?: Json | null
        }
        Update: {
          id?: string
          project_id?: string
          user_id?: string
          created_at?: string
          execution_profile_used?: string
          active_plugins?: Json
          model_config_used?: Json
          ast_context?: Json
          scan_size_bytes?: number
          files_scanned_count?: number
          skipped_files_count?: number
          findings_list?: Json
          overall_risk?: string
          performance?: Json
          swarm_execution_data?: Json | null
        }
        Relationships: []
      }
      hexical_runtime_kv: {
        Row: { key: string; value: Json; expires_at: string | null; updated_at: string }
        Insert: { key: string; value: Json; expires_at?: string | null; updated_at?: string }
        Update: { key?: string; value?: Json; expires_at?: string | null; updated_at?: string }
        Relationships: []
      }
      hexical_runtime_hashes: {
        Row: { key: string; field: string; value: string; expires_at: string | null; updated_at: string }
        Insert: { key: string; field: string; value: string; expires_at?: string | null; updated_at?: string }
        Update: { key?: string; field?: string; value?: string; expires_at?: string | null; updated_at?: string }
        Relationships: []
      }
      hexical_runtime_set_members: {
        Row: { key: string; member: string; created_at: string }
        Insert: { key: string; member: string; created_at?: string }
        Update: { key?: string; member?: string; created_at?: string }
        Relationships: []
      }
      hexical_runtime_sorted_members: {
        Row: { key: string; member: string; score: number; created_at: string }
        Insert: { key: string; member: string; score: number; created_at?: string }
        Update: { key?: string; member?: string; score?: number; created_at?: string }
        Relationships: []
      }
      hexical_runtime_stream_entries: {
        Row: {
          stream_key: string
          stream_sequence: number
          stream_id: string
          fields: Json
          expires_at: string | null
          created_at: string
        }
        Insert: {
          stream_key: string
          stream_sequence: number
          stream_id: string
          fields: Json
          expires_at?: string | null
          created_at?: string
        }
        Update: {
          stream_key?: string
          stream_sequence?: number
          stream_id?: string
          fields?: Json
          expires_at?: string | null
          created_at?: string
        }
        Relationships: []
      }
    }
    Views: Record<string, never>
    Functions: {
      hexical_runtime_set_value: {
        Args: { p_key: string; p_value: Json; p_ttl_seconds: number | null; p_nx: boolean }
        Returns: string | null
      }
      hexical_runtime_delete_keys: {
        Args: { p_keys: string[] }
        Returns: number
      }
      hexical_runtime_increment_value: {
        Args: { p_key: string; p_delta: number }
        Returns: number
      }
      hexical_runtime_expire_key: {
        Args: { p_key: string; p_ttl_seconds: number }
        Returns: number
      }
      hexical_runtime_append_stream: {
        Args: { p_stream_key: string; p_fields: Json }
        Returns: string
      }
      hexical_runtime_eval: {
        Args: { p_operation: string; p_keys: string[]; p_args: string[] }
        Returns: Json
      }
      hexical_investigation_rate_limit: {
        Args: {
          p_key: string
          p_capacity: number
          p_window_seconds: number
          p_now_ms: number
          p_member: string
        }
        Returns: Json
      }
      hexical_investigation_reserve_budget: {
        Args: { p_key: string; p_amount: number; p_cap: number; p_ttl_seconds: number }
        Returns: Json
      }
      hexical_investigation_reconcile_budget: {
        Args: { p_key: string; p_delta: number }
        Returns: number
      }
    }
    Enums: Record<string, never>
    CompositeTypes: Record<string, never>
  }
}
