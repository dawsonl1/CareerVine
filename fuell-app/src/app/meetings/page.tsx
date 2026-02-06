/**
 * Meetings page - Interface for tracking meetings and interactions
 * 
 * This page provides:
 * - List view of all meetings with attendee information
 * - Create new meetings with date, type, notes, and transcripts
 * - Display meeting attendees (contacts)
 * - Show meeting notes and transcripts
 * - Modal forms for meeting creation
 * - Error handling and loading states
 * 
 * Meeting features:
 * - Multiple meeting types (coffee, video, phone, etc.)
 * - Attendee tracking via meeting_contacts join table
 * - Notes and transcript storage
 * - Chronological ordering (most recent first)
 */

"use client";

import { useState, useEffect } from "react";
import { useAuth } from "@/components/auth-provider";
import Navigation from "@/components/navigation";
import { getMeetings, createMeeting } from "@/lib/queries";
import type { Database } from "@/lib/database.types";

// Type definition for Meeting with attendee data
// This matches what the getMeetings query returns with contact joins
type Meeting = Database["public"]["Tables"]["meetings"]["Row"] & {
  meeting_contacts: (Database["public"]["Tables"]["meeting_contacts"]["Row"] & {
    contacts: Database["public"]["Tables"]["contacts"]["Row"];
  })[];
};

export default function MeetingsPage() {
  // Get current authenticated user
  const { user } = useAuth();
  
  // Component state
  const [meetings, setMeetings] = useState<Meeting[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [formData, setFormData] = useState({
    meeting_date: "",
    meeting_type: "",
    notes: "",
    transcript: "",
  });

  // Load meetings when component mounts or user changes
  useEffect(() => {
    if (user) {
      loadMeetings();
    }
  }, [user]);

  /**
   * Load all meetings for the current user
   * Includes attendee information via the meeting_contacts join table
   */
  const loadMeetings = async () => {
    if (!user) return;
    try {
      const data = await getMeetings(user.id);
      setMeetings(data as Meeting[]);
    } catch (error) {
      console.error("Error loading meetings:", error);
    } finally {
      setLoading(false);
    }
  };

  /**
   * Handle form submission for creating a new meeting
   * 
   * @param e - Form submission event
   */
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user) return;

    try {
      const meetingData = {
        user_id: user.id,
        meeting_date: formData.meeting_date,
        meeting_type: formData.meeting_type,
        notes: formData.notes || null,
        transcript: formData.transcript || null,
      };

      await createMeeting(meetingData);
      await loadMeetings();
      setShowForm(false);
      setFormData({
        meeting_date: "",
        meeting_type: "",
        notes: "",
        transcript: "",
      });
    } catch (error) {
      console.error("Error creating meeting:", error);
    }
  };

  // Show loading state while fetching meetings
  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50">
        <Navigation />
        <div className="p-8">Loading meetings...</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <Navigation />
      <div className="p-8">
        {/* Page header with add button */}
        <div className="flex justify-between items-center mb-6">
          <h1 className="text-2xl font-bold">Meetings</h1>
          <button
            onClick={() => setShowForm(true)}
            className="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700"
          >
            Add Meeting
          </button>
        </div>

        {/* Add meeting modal form */}
        {showForm && (
          <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
            <div className="bg-white rounded-lg p-6 w-full max-w-2xl max-h-[90vh] overflow-y-auto">
              <h2 className="text-xl font-bold mb-4">Add Meeting</h2>
              <form onSubmit={handleSubmit} className="space-y-4">
                {/* Meeting date and time - required field */}
                <div>
                  <label className="block text-sm font-medium mb-1">Date & Time *</label>
                  <input
                    type="datetime-local"
                    required
                    value={formData.meeting_date}
                    onChange={(e) => setFormData({ ...formData, meeting_date: e.target.value })}
                    className="w-full border rounded px-3 py-2"
                  />
                </div>

                {/* Meeting type - required field */}
                <div>
                  <label className="block text-sm font-medium mb-1">Meeting Type *</label>
                  <select
                    required
                    value={formData.meeting_type}
                    onChange={(e) => setFormData({ ...formData, meeting_type: e.target.value })}
                    className="w-full border rounded px-3 py-2"
                  >
                    <option value="">Select type...</option>
                    <option value="coffee">Coffee Chat</option>
                    <option value="video">Video Call</option>
                    <option value="phone">Phone Call</option>
                    <option value="in-person">In-Person Meeting</option>
                    <option value="conference">Conference</option>
                    <option value="other">Other</option>
                  </select>
                </div>

                {/* Meeting notes - optional */}
                <div>
                  <label className="block text-sm font-medium mb-1">Notes</label>
                  <textarea
                    value={formData.notes}
                    onChange={(e) => setFormData({ ...formData, notes: e.target.value })}
                    className="w-full border rounded px-3 py-2"
                    rows={4}
                    placeholder="Key takeaways, action items, follow-ups..."
                  />
                </div>

                {/* Meeting transcript - optional */}
                <div>
                  <label className="block text-sm font-medium mb-1">Transcript</label>
                  <textarea
                    value={formData.transcript}
                    onChange={(e) => setFormData({ ...formData, transcript: e.target.value })}
                    className="w-full border rounded px-3 py-2"
                    rows={6}
                    placeholder="Full transcript or detailed notes..."
                  />
                </div>

                {/* Form action buttons */}
                <div className="flex justify-end space-x-2">
                  <button
                    type="button"
                    onClick={() => setShowForm(false)}
                    className="px-4 py-2 border rounded hover:bg-gray-50"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    className="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700"
                  >
                    Create
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}

        {/* Meetings list */}
        <div className="space-y-4">
          {meetings.map((meeting) => (
            <div key={meeting.id} className="bg-white p-6 rounded-lg shadow">
              {/* Meeting header with basic info */}
              <div className="flex justify-between items-start mb-4">
                <div>
                  <h3 className="text-lg font-semibold capitalize">
                    {meeting.meeting_type}
                  </h3>
                  <p className="text-gray-600">
                    {new Date(meeting.meeting_date).toLocaleString()}
                  </p>
                </div>
              </div>
              
              {/* Meeting attendees */}
              {meeting.meeting_contacts.length > 0 && (
                <div className="mb-4">
                  <p className="text-sm font-medium mb-2">Attendees:</p>
                  <div className="flex flex-wrap gap-2">
                    {meeting.meeting_contacts.map((mc) => (
                      <span
                        key={mc.contact_id}
                        className="inline-block bg-blue-100 text-blue-800 text-sm px-3 py-1 rounded-full"
                      >
                        {mc.contacts.name}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {/* Meeting notes */}
              {meeting.notes && (
                <div className="mb-4">
                  <p className="text-sm font-medium mb-1">Notes:</p>
                  <p className="text-gray-700 whitespace-pre-wrap">{meeting.notes}</p>
                </div>
              )}

              {/* Meeting transcript */}
              {meeting.transcript && (
                <div>
                  <p className="text-sm font-medium mb-1">Transcript:</p>
                  <div className="bg-gray-50 p-3 rounded text-sm text-gray-700 max-h-40 overflow-y-auto">
                    <pre className="whitespace-pre-wrap">{meeting.transcript}</pre>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
