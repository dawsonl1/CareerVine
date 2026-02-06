/**
 * Contacts page - Full CRUD interface for managing contacts
 * 
 * This page provides:
 * - List view of all contacts with related data
 * - Create new contact with form validation
 * - Edit existing contact information
 * - Delete contact with confirmation
 * - Display related emails, phones, companies, schools, and tags
 * - Modal forms for add/edit operations
 * - Error handling and loading states
 * 
 * Data relationships handled:
 * - Multiple emails and phones per contact
 * - Employment history with companies
 * - Education history with schools
 * - Tag associations for categorization
 */

"use client";

import { useState, useEffect } from "react";
import { useAuth } from "@/components/auth-provider";
import Navigation from "@/components/navigation";
import { getContacts, createContact, updateContact, deleteContact } from "@/lib/queries";
import type { Database } from "@/lib/database.types";

// Type definition for Contact with all related data
// This matches what the getContacts query returns with all joins
type Contact = Database["public"]["Tables"]["contacts"]["Row"] & {
  contact_emails: Database["public"]["Tables"]["contact_emails"]["Row"][];
  contact_phones: Database["public"]["Tables"]["contact_phones"]["Row"][];
  contact_companies: (Database["public"]["Tables"]["contact_companies"]["Row"] & {
    companies: Database["public"]["Tables"]["companies"]["Row"];
  })[];
  contact_schools: (Database["public"]["Tables"]["contact_schools"]["Row"] & {
    schools: Database["public"]["Tables"]["schools"]["Row"];
  })[];
  contact_tags: (Database["public"]["Tables"]["contact_tags"]["Row"] & {
    tags: Database["public"]["Tables"]["tags"]["Row"];
  })[];
};

export default function ContactsPage() {
  // Get current authenticated user
  const { user } = useAuth();
  
  // Component state
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editingContact, setEditingContact] = useState<Contact | null>(null);
  const [formData, setFormData] = useState({
    name: "",
    industry: "",
    role: "",
    linkedin_url: "",
    notes: "",
    met_through: "",
    follow_up_frequency_days: "",
    preferred_contact_method: "",
    preferred_contact_value: "",
  });

  // Load contacts when component mounts or user changes
  useEffect(() => {
    if (user) {
      loadContacts();
    }
  }, [user]);

  /**
   * Load all contacts for the current user
   * Includes all related data via joins in the query
   */
  const loadContacts = async () => {
    if (!user) return;
    try {
      const data = await getContacts(user.id);
      setContacts(data as Contact[]);
    } catch (error) {
      console.error("Error loading contacts:", error);
    } finally {
      setLoading(false);
    }
  };

  /**
   * Handle form submission for both create and update operations
   * 
   * @param e - Form submission event
   */
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user) return;

    try {
      const contactData = {
        user_id: user.id,
        name: formData.name,
        industry: formData.industry || null,
        role: formData.role || null,
        linkedin_url: formData.linkedin_url || null,
        notes: formData.notes || null,
        met_through: formData.met_through || null,
        follow_up_frequency_days: formData.follow_up_frequency_days ? parseInt(formData.follow_up_frequency_days) : null,
        preferred_contact_method: formData.preferred_contact_method || null,
        preferred_contact_value: formData.preferred_contact_value || null,
      };

      if (editingContact) {
        // Update existing contact
        await updateContact(editingContact.id, contactData);
      } else {
        // Create new contact
        await createContact(contactData);
      }
      
      // Reload contacts to show updated data
      await loadContacts();
      
      // Close form and reset state
      setShowForm(false);
      setEditingContact(null);
      setFormData({
        name: "",
        industry: "",
        role: "",
        linkedin_url: "",
        notes: "",
        met_through: "",
        follow_up_frequency_days: "",
        preferred_contact_method: "",
        preferred_contact_value: "",
      });
    } catch (error) {
      console.error("Error saving contact:", error);
    }
  };

  /**
   * Handle contact deletion
   * 
   * Note: Due to foreign key constraints with ON DELETE CASCADE,
   * this will automatically delete related emails, phones, etc.
   * 
   * @param id - Contact ID to delete
   */
  const handleDelete = async (id: number) => {
    if (!confirm("Are you sure you want to delete this contact? This cannot be undone.")) {
      return;
    }

    try {
      await deleteContact(id);
      await loadContacts();
    } catch (error) {
      console.error("Error deleting contact:", error);
    }
  };

  /**
   * Open form for editing an existing contact
   * 
   * @param contact - Contact data to edit
   */
  const handleEdit = (contact: Contact) => {
    setEditingContact(contact);
    setFormData({
      name: contact.name,
      industry: contact.industry || "",
      role: contact.role || "",
      linkedin_url: contact.linkedin_url || "",
      notes: contact.notes || "",
      met_through: contact.met_through || "",
      follow_up_frequency_days: contact.follow_up_frequency_days?.toString() || "",
      preferred_contact_method: contact.preferred_contact_method || "",
      preferred_contact_value: contact.preferred_contact_value || "",
    });
    setShowForm(true);
  };

  // Show loading state while fetching contacts
  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50">
        <Navigation />
        <div className="p-8">Loading contacts...</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <Navigation />
      <div className="p-8">
        {/* Page header with add button */}
        <div className="flex justify-between items-center mb-6">
          <h1 className="text-2xl font-bold">Contacts</h1>
          <button
            onClick={() => setShowForm(true)}
            className="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700"
          >
            Add Contact
          </button>
        </div>

        {/* Add/Edit contact modal form */}
        {showForm && (
          <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
            <div className="bg-white rounded-lg p-6 w-full max-w-2xl max-h-[90vh] overflow-y-auto">
              <h2 className="text-xl font-bold mb-4">
                {editingContact ? "Edit Contact" : "Add Contact"}
              </h2>
              <form onSubmit={handleSubmit} className="space-y-4">
                {/* Contact name - required field */}
                <div>
                  <label className="block text-sm font-medium mb-1">Name *</label>
                  <input
                    type="text"
                    required
                    value={formData.name}
                    onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                    className="w-full border rounded px-3 py-2"
                  />
                </div>

                {/* Optional fields */}
                <div>
                  <label className="block text-sm font-medium mb-1">Industry</label>
                  <input
                    type="text"
                    value={formData.industry}
                    onChange={(e) => setFormData({ ...formData, industry: e.target.value })}
                    className="w-full border rounded px-3 py-2"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium mb-1">Role</label>
                  <input
                    type="text"
                    value={formData.role}
                    onChange={(e) => setFormData({ ...formData, role: e.target.value })}
                    className="w-full border rounded px-3 py-2"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium mb-1">LinkedIn URL</label>
                  <input
                    type="url"
                    value={formData.linkedin_url}
                    onChange={(e) => setFormData({ ...formData, linkedin_url: e.target.value })}
                    className="w-full border rounded px-3 py-2"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium mb-1">How you met</label>
                  <input
                    type="text"
                    value={formData.met_through}
                    onChange={(e) => setFormData({ ...formData, met_through: e.target.value })}
                    className="w-full border rounded px-3 py-2"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium mb-1">Follow-up frequency (days)</label>
                  <input
                    type="number"
                    value={formData.follow_up_frequency_days}
                    onChange={(e) => setFormData({ ...formData, follow_up_frequency_days: e.target.value })}
                    className="w-full border rounded px-3 py-2"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium mb-1">Preferred contact method</label>
                  <select
                    value={formData.preferred_contact_method}
                    onChange={(e) => setFormData({ ...formData, preferred_contact_method: e.target.value })}
                    className="w-full border rounded px-3 py-2"
                  >
                    <option value="">Select...</option>
                    <option value="email">Email</option>
                    <option value="phone">Phone</option>
                    <option value="linkedin">LinkedIn</option>
                  </select>
                </div>

                <div>
                  <label className="block text-sm font-medium mb-1">Preferred contact value</label>
                  <input
                    type="text"
                    value={formData.preferred_contact_value}
                    onChange={(e) => setFormData({ ...formData, preferred_contact_value: e.target.value })}
                    className="w-full border rounded px-3 py-2"
                    placeholder="Email address, phone number, or LinkedIn URL"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium mb-1">Notes</label>
                  <textarea
                    value={formData.notes}
                    onChange={(e) => setFormData({ ...formData, notes: e.target.value })}
                    className="w-full border rounded px-3 py-2"
                    rows={4}
                  />
                </div>

                {/* Form action buttons */}
                <div className="flex justify-end space-x-2">
                  <button
                    type="button"
                    onClick={() => {
                      setShowForm(false);
                      setEditingContact(null);
                      setFormData({
                        name: "",
                        industry: "",
                        role: "",
                        linkedin_url: "",
                        notes: "",
                        met_through: "",
                        follow_up_frequency_days: "",
                        preferred_contact_method: "",
                        preferred_contact_value: "",
                      });
                    }}
                    className="px-4 py-2 border rounded hover:bg-gray-50"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    className="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700"
                  >
                    {editingContact ? "Update" : "Create"}
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}

        {/* Contacts list */}
        <div className="space-y-4">
          {contacts.map((contact) => (
            <div key={contact.id} className="bg-white p-6 rounded-lg shadow">
              {/* Contact header with actions */}
              <div className="flex justify-between items-start mb-4">
                <div>
                  <h3 className="text-lg font-semibold">{contact.name}</h3>
                  {contact.role && <p className="text-gray-600">{contact.role}</p>}
                  {contact.industry && <p className="text-gray-600">{contact.industry}</p>}
                </div>
                <div className="flex space-x-2">
                  <button
                    onClick={() => handleEdit(contact)}
                    className="text-blue-600 hover:text-blue-800"
                  >
                    Edit
                  </button>
                  <button
                    onClick={() => handleDelete(contact.id)}
                    className="text-red-600 hover:text-red-800"
                  >
                    Delete
                  </button>
                </div>
              </div>

              {/* Contact details */}
              {contact.linkedin_url && (
                <div className="mb-2">
                  <a
                    href={contact.linkedin_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-blue-600 hover:text-blue-800"
                  >
                    LinkedIn Profile
                  </a>
                </div>
              )}

              {/* Email addresses */}
              {contact.contact_emails.length > 0 && (
                <div className="mb-2">
                  <p className="text-sm font-medium">Emails:</p>
                  {contact.contact_emails.map((email) => (
                    <p key={email.id} className="text-sm text-gray-600">
                      {email.email} {email.is_primary && "(Primary)"}
                    </p>
                  ))}
                </div>
              )}

              {/* Phone numbers */}
              {contact.contact_phones.length > 0 && (
                <div className="mb-2">
                  <p className="text-sm font-medium">Phones:</p>
                  {contact.contact_phones.map((phone) => (
                    <p key={phone.id} className="text-sm text-gray-600">
                      {phone.phone} ({phone.type}) {phone.is_primary && "(Primary)"}
                    </p>
                  ))}
                </div>
              )}

              {/* Employment history */}
              {contact.contact_companies.length > 0 && (
                <div className="mb-2">
                  <p className="text-sm font-medium">Companies:</p>
                  {contact.contact_companies.map((cc) => (
                    <p key={cc.id} className="text-sm text-gray-600">
                      {cc.title} at {cc.companies.name}
                      {cc.start_date && ` (${cc.start_date} - ${cc.end_date || "Present"})`}
                    </p>
                  ))}
                </div>
              )}

              {/* Education history */}
              {contact.contact_schools.length > 0 && (
                <div className="mb-2">
                  <p className="text-sm font-medium">Education:</p>
                  {contact.contact_schools.map((cs) => (
                    <p key={cs.id} className="text-sm text-gray-600">
                      {cs.degree} in {cs.field_of_study} from {cs.schools.name}
                      {cs.start_year && ` (${cs.start_year} - ${cs.end_year || "Present"})`}
                    </p>
                  ))}
                </div>
              )}

              {/* Tags */}
              {contact.contact_tags.length > 0 && (
                <div className="mb-2">
                  <p className="text-sm font-medium">Tags:</p>
                  <div className="flex flex-wrap gap-2">
                    {contact.contact_tags.map((ct) => (
                      <span
                        key={ct.tag_id}
                        className="inline-block bg-blue-100 text-blue-800 text-sm px-3 py-1 rounded-full"
                      >
                        {ct.tags.name}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {/* Notes */}
              {contact.notes && (
                <div className="mt-4">
                  <p className="text-sm font-medium">Notes:</p>
                  <p className="text-gray-700 whitespace-pre-wrap">{contact.notes}</p>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
