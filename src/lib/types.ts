export type Role = 'owner' | 'office' | 'technician'
export type ProviderId = 'jio' | 'airtel' | 'bsnl' | 'niss'
export type Status = 'new' | 'assigned' | 'in_progress' | 'waiting_customer' | 'waiting_provider' | 'resolved' | 'closed'
export type Priority = 'low' | 'normal' | 'high' | 'urgent'
export interface Company { id: string; name: string; created_at: string }
export interface Profile { id: string; company_id: string; full_name: string; role: Role; active: boolean; must_change_password: boolean; whatsapp_number?: string }
export interface Provider { id: ProviderId; name: string }
export interface Customer { id: string; company_id: string; full_name: string; phone: string; address: string; area: string; created_at: string }
export interface Connection { id: string; company_id: string; customer_id: string; provider_id: ProviderId; account_number: string; network_node: string }
export interface Outage { id: string; company_id: string; provider_id: ProviderId; area: string; title: string; status: 'active' | 'restored'; created_at: string; restored_at: string | null }
export interface Ticket {
  id: string; company_id: string; number: number; connection_id: string | null; title: string; description: string; category: string;
  priority: Priority; status: Status; assigned_to: string | string[] | null; outage_id: string | null;
  provider_reference: string; due_at: string | null; visit_at: string | null; follow_up_at: string | null;
  resolution: string; customer_feedback?: string; created_at: string; updated_at: string; version: number
}
export interface TicketEvent { id: string; company_id: string; ticket_id: string; actor_id: string; body: string; created_at: string }
export interface TicketImage { id: string; ticket_id: string; created_at: string; uploaded_by: string; url: string }
export interface Dataset { companies: Company[]; tickets: Ticket[]; customers: Customer[]; connections: Connection[]; outages: Outage[]; profiles: Profile[]; providers: Provider[] }
export interface CustomerInput { full_name: string; phone: string; address: string; area: string; provider_id: ProviderId; account_number: string; network_node: string }
export type TicketInput = Pick<Ticket, 'id' | 'connection_id' | 'title' | 'description' | 'category' | 'priority' | 'assigned_to' | 'due_at' | 'outage_id'>
export type TicketPatch = Partial<Pick<Ticket, 'status' | 'title' | 'description' | 'priority' | 'assigned_to' | 'outage_id' | 'provider_reference' | 'due_at' | 'visit_at' | 'follow_up_at' | 'resolution' | 'customer_feedback'>>
export type OutageInput = Pick<Outage, 'provider_id' | 'area' | 'title'>
export type StaffInput =
  | { action: 'create'; full_name: string; email: string; password: string; role: 'office' | 'technician'; whatsapp_number?: string }
  | { action: 'set_whatsapp'; id: string; whatsapp_number: string }
  | { action: 'update'; id: string; role?: 'office' | 'technician'; active?: boolean }
  | { action: 'reset_password'; id: string; password: string }
  | { action: 'change_password'; password: string }
export interface DateRange { from: string; to: string }
export type AttendanceStatus = 'present' | 'absent' | 'half_day' | 'leave'
export interface AttendanceInput { id: string; employee_id: string; day: string; status: AttendanceStatus; check_in: string | null; check_out: string | null; note: string; version: number }
export interface AttendanceRecord extends AttendanceInput { company_id: string; recorded_by: string | null; updated_by: string | null; updated_at: string | null }
export interface AttendanceReport extends DateRange { generated_at: string; records: AttendanceRecord[] }
export interface AssignmentNotification { id: string; company_id: string; recipient_id: string; ticket_id: string; ticket_number: number; kind: 'created' | 'assigned'; created_at: string; read_at: string | null }
export interface NotificationFeed { items: AssignmentNotification[]; unread_count: number }
export interface PerformanceEmployee {
  id: string; full_name: string; role: Role; active: boolean;
  open_assigned: number; overdue_assigned: number; awaiting_feedback_assigned: number;
  created: number; resolved: number; closed: number; feedback_recorded: number;
  median_resolution_hours: number | null;
}
export interface PerformanceReport extends DateRange { generated_at: string; employees: PerformanceEmployee[] }
export interface DataApi {
  attendance(range: DateRange, signal?: AbortSignal): Promise<AttendanceReport>;
  saveAttendance(input: AttendanceInput): Promise<void>;
  notifications(signal?: AbortSignal): Promise<NotificationFeed>;
  readNotifications(id?: string): Promise<void>;
  performance?(range: DateRange, signal?: AbortSignal): Promise<PerformanceReport>;
  load(signal?: AbortSignal): Promise<Dataset>;
  profile(id: string, signal?: AbortSignal): Promise<Profile>;
  events(id: string, signal?: AbortSignal): Promise<TicketEvent[]>;
  createCustomer(input: CustomerInput): Promise<string>;
  createTicket(input: TicketInput): Promise<void>;
  updateTicket(id: string, version: number, patch: TicketPatch, note: string): Promise<void>;
  deleteTicket(id: string, version: number, confirmation: string, reason: string): Promise<void>;
  createOutage(input: OutageInput): Promise<void>;
  restoreOutage(id: string): Promise<void>;
  staff(input: StaffInput): Promise<void>;
  attachments?(ticketId: string, signal?: AbortSignal): Promise<TicketImage[]>;
  uploadImage?(ticketId: string, file: File): Promise<void>;
  deleteImage?(ticketId: string, imageId: string): Promise<void>;
}