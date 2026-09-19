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
      hexical_repository_contexts: {
        Row: {
          id: string
          owner_user_id: string
          repository_key: string
          root: string
          status: string
          summary: Json
          limitations: Json
          file_count: number
          node_count: number
          edge_count: number
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          owner_user_id: string
          repository_key: string
          root?: string
          status?: string
          summary?: Json
          limitations?: Json
          file_count?: number
          node_count?: number
          edge_count?: number
          created_at?: string
          updated_at?: string
        }
        Update: {
          id?: string
          owner_user_id?: string
          repository_key?: string
          root?: string
          status?: string
          summary?: Json
          limitations?: Json
          file_count?: number
          node_count?: number
          edge_count?: number
          created_at?: string
          updated_at?: string
        }
        Relationships: []
      }
      hexical_repository_nodes: {
        Row: {
          id: string
          repository_id: string
          owner_user_id: string
          node_id: string
          kind: string
          node_key: string
          name: string
          path: string | null
          language: string | null
          metadata: Json
          created_at: string
        }
        Insert: {
          id?: string
          repository_id: string
          owner_user_id: string
          node_id: string
          kind: string
          node_key: string
          name: string
          path?: string | null
          language?: string | null
          metadata?: Json
          created_at?: string
        }
        Update: {
          id?: string
          repository_id?: string
          owner_user_id?: string
          node_id?: string
          kind?: string
          node_key?: string
          name?: string
          path?: string | null
          language?: string | null
          metadata?: Json
          created_at?: string
        }
        Relationships: []
      }
      hexical_repository_edges: {
        Row: {
          id: string
          repository_id: string
          owner_user_id: string
          edge_id: string
          source_node_id: string
          target_node_id: string
          relation: string
          direct: boolean
          confidence: string
          evidence: Json
          created_at: string
        }
        Insert: {
          id?: string
          repository_id: string
          owner_user_id: string
          edge_id: string
          source_node_id: string
          target_node_id: string
          relation: string
          direct?: boolean
          confidence: string
          evidence?: Json
          created_at?: string
        }
        Update: {
          id?: string
          repository_id?: string
          owner_user_id?: string
          edge_id?: string
          source_node_id?: string
          target_node_id?: string
          relation?: string
          direct?: boolean
          confidence?: string
          evidence?: Json
          created_at?: string
        }
        Relationships: []
      }
      hexical_engineering_runs: {
        Row: {
          id: string
          owner_user_id: string
          repository_id: string
          objective: string
          status: string
          verification_status: string | null
          errors: Json
          correlation_id: string
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          owner_user_id: string
          repository_id: string
          objective: string
          status: string
          verification_status?: string | null
          errors?: Json
          correlation_id: string
          created_at?: string
          updated_at?: string
        }
        Update: {
          id?: string
          owner_user_id?: string
          repository_id?: string
          objective?: string
          status?: string
          verification_status?: string | null
          errors?: Json
          correlation_id?: string
          created_at?: string
          updated_at?: string
        }
        Relationships: []
      }
      hexical_engineering_tasks: {
        Row: {
          id: string
          run_id: string
          owner_user_id: string
          role: string
          objective: string
          status: string
          input_context: Json
          findings: Json
          evidence: Json
          confidence: number | null
          error: string | null
          started_at: string | null
          completed_at: string | null
          created_at: string
        }
        Insert: {
          id?: string
          run_id: string
          owner_user_id: string
          role: string
          objective: string
          status: string
          input_context?: Json
          findings?: Json
          evidence?: Json
          confidence?: number | null
          error?: string | null
          started_at?: string | null
          completed_at?: string | null
          created_at?: string
        }
        Update: {
          id?: string
          run_id?: string
          owner_user_id?: string
          role?: string
          objective?: string
          status?: string
          input_context?: Json
          findings?: Json
          evidence?: Json
          confidence?: number | null
          error?: string | null
          started_at?: string | null
          completed_at?: string | null
          created_at?: string
        }
        Relationships: []
      }
      hexical_engineering_evidence: {
        Row: {
          id: string
          run_id: string
          owner_user_id: string
          evidence_type: string
          certainty: string
          title: string
          explanation: string
          source: Json | null
          payload: Json | null
          created_at: string
        }
        Insert: {
          id?: string
          run_id: string
          owner_user_id: string
          evidence_type: string
          certainty: string
          title: string
          explanation: string
          source?: Json | null
          payload?: Json | null
          created_at?: string
        }
        Update: {
          id?: string
          run_id?: string
          owner_user_id?: string
          evidence_type?: string
          certainty?: string
          title?: string
          explanation?: string
          source?: Json | null
          payload?: Json | null
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
      hexical_runtime_add_set_members: {
        Args: { p_key: string; p_members: string[] }
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
      hexical_evidence_graph_eval: {
        Args: { p_operation: string; p_keys: string[]; p_args: string[] }
        Returns: number
      }
      process_payment_webhook: {
        Args: {
          p_payment_id: string
          p_user_id: string
          p_order_id: string | null
          p_tier: string
          p_tokens: number
          p_period_days: number
        }
        Returns: { already_processed: boolean }[]
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
