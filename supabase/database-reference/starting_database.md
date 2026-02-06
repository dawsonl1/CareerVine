Current information that will need storing:

User:
- Name
- Email
- Phone

Each Contact:
- Name (required)
- Company (optional)
    - We should be able to store previous companies
- Industry (optional)
- Role (optional)
- LinkedIn Profile (optional)
- Email (optional)
- Phone (optional)
- Notes (this will be longer text)
- School
    - We should be able to store multiple schools
- Met through (this will be longer text)
- follow up frequency
- All the meetings had with this contact
- All the introductions to others had through this contact
- A history of interactions with this contact (this will likely connected to another table with the history of interactions) (examples: linkedin conversation, email back and forth, in person meeting, texting back and forth, email follow up) (it will also include a free text summary of what was said or the follow up message sent)
- Tagging system
- Attachments
- Perfered contact method

Each Meeting:
- Contact/contacts (contacts if the meeting was with multiple people)
- Date
- Notes
- Meeting Type (In Person, Video Call, Phone Call)
- Transcript (optional)
- Personal Action Items (optional) (actions that the user needs to do)
- Contact Action Items (optional) (actions that the contact needs to do) (this needs to support multiple items for potentially multiple contacts from a single meeting)
- Introductions to others (optional) (this needs to support which contact introduced the user to which other contact)

I think there should be two differnet types of action items,
- Post meeting action items (personal and contact)
- Follow up action items (when a contact is due to be followed up with)

Post Meeting Action Items:
- Personal or which contact it is for
- What meeting it came from
- WHat to do
- Timeline for when it should be done
- Is it completed

Follow Up Action Items:
- Last recorded follow up date when the action item was created
- Is it completed
- What to say
