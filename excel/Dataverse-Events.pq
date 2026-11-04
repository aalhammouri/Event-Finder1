// Dataverse Events -> Marketing Campaigns.xlsm
// Paste into Power Query: Home > Advanced Editor (replace everything).
// Source: GCP Package Desk events (lead table, rows with an Event ID) in sandbox orgcad402f2.
let
    Source  = CommonDataService.Database("orgcad402f2.crm.dynamics.com"),
    Leads   = Source{[Schema = "dbo", Item = "lead"]}[Data],

    // 1. Only Desk events (not ordinary sales leads). Uncomment the statecode line to hide archived ones.
    Events  = Table.SelectRows(Leads, each [lead_event_id] <> null
                                    // and [statecode] = 0
                              ),

    // 2. Dataverse column -> your sheet header, in your sheet's order
    Map = {
        {"lead_event_id",                      "Event ID"},
        {"lead_online_auction",                "GCP - Online Auction"},
        {"lead_live_auction",                  "GCP - Live Auction"},
        {"lead_silent_auction",                "GCP - Silent Auction"},
        {"lead_raffle",                        "GCP - Raffle"},
        {"lead_event_web_page",                "GCP - Event Web Page"},
        {"lead_event_date",                    "GCP - Event Date Sort"},
        {"lead_beneficiary_org",               "GCP - Beneficiary of Fundraiser"},
        {"subject",                            "GCP - Event"},
        {"address1_line1",                     "Mailing Address 1"},
        {"address1_line2",                     "Mailing Address 2"},
        {"address1_line3",                     "Mailing Address 3"},
        {"address1_city",                      "Mailing City"},
        {"address1_stateorprovince",           "Mailing State"},
        {"address1_postalcode",                "Mailing Zip"},
        {"telephone1",                         "Phone - Business"},
        {"emailaddress1",                      "E-mail"},
        {"fullname",                           "Contact"},
        {"websiteurl",                         "Web Site"},
        {"companyname",                        "Company"},
        {"lead_found_on",                      "First Seen"},
        {"jobtitle",                           "Event Contact Title"},
        {"lead_contact_employee_or_volunteer", "Employee or Volunteer"},
        {"lead_event_contact_2_name",          "Event Contact Person 2"},
        {"lead_event_contact_2_email",         "Event Contact Person 2 E-mail"},
        {"lead_event_contact_2_phone",         "Event Contact Person 2 Phone Number"},
        {"lead_gcp_stage",                     "GCP - Event Status"},
        {"leadsourcecode",                     "_src"},
        {"lead_source_of_event_information",   "_srcinfo"}
    },
    Kept    = Table.SelectColumns(Events, List.Transform(Map, each _{0}), MissingField.UseNull),
    Renamed = Table.RenameColumns(Kept, Map),

    // 3. Turn the 714000000-style codes into words
    YNU    = [#"714000000" = "Yes", #"714000001" = "No", #"714000002" = "Unclear"],
    EmpVol = [#"714000000" = "Employee", #"714000001" = "Volunteer"],
    Stage  = [#"714000010" = "Pending", #"714000011" = "Pending - Ready to Merge", #"714000012" = "Pending - Merged",
              #"714000013" = "Printed", #"714000014" = "Assembled and Sealed", #"714000015" = "Open - Mailed"],
    Src    = [#"714000000" = "AI Search"],
    SrcInf = [#"714000120" = "AI Search", #"714000121" = "Charity Website", #"714000122" = "Facebook",
              #"714000123" = "Fundraising Platform", #"714000124" = "Referral", #"714000125" = "Client", #"714000126" = "Other"],
    Label  = (m as record) => (v) => if v = null then null else Record.FieldOrDefault(m, Text.From(v), null),
    Decoded = Table.TransformColumns(Renamed, {
        {"GCP - Online Auction",  Label(YNU),    type text},
        {"GCP - Live Auction",    Label(YNU),    type text},
        {"GCP - Silent Auction",  Label(YNU),    type text},
        {"GCP - Raffle",          Label(YNU),    type text},
        {"Employee or Volunteer", Label(EmpVol), type text},
        {"GCP - Event Status",    Label(Stage),  type text},
        {"_src",                  Label(Src),    type text},
        {"_srcinfo",              Label(SrcInf), type text}
    }),

    // 4. Clean text: trim, blank -> empty cell, drop "[GCP] " prefix from event names
    TextCols = List.Difference(Table.ColumnNames(Decoded), {"GCP - Event Date Sort", "First Seen"}),
    Trimmed  = Table.TransformColumns(Decoded,
                 List.Transform(TextCols, (c) => {c, each
                     let t = if _ = null then null else Text.Trim(Text.From(_))
                     in  if t = "" then null else t, type text})),
    NoPrefix = Table.TransformColumns(Trimmed, {{"GCP - Event",
                 each if _ <> null and Text.StartsWith(_, "[GCP] ") then Text.Middle(_, 6) else _, type text}}),
    // Contact is left exactly as the scan wrote it (org name = no person found), so you can grade the AI.

    // 5. Dates only (no 12:00 PM time)
    Dated = Table.TransformColumns(NoPrefix, {
        {"GCP - Event Date Sort", each if _ = null then null else DateTime.Date(_), type date},
        {"First Seen",            each if _ = null then null else DateTime.Date(_), type date}
    }),

    // 6. Columns your sheet has that are built from other fields
    AddEC   = Table.AddColumn(Dated,  "Event Contact",              each [Contact], type text),
    AddECPh = Table.AddColumn(AddEC,  "Event Contact Phone Number", each [#"Phone - Business"], type text),
    AddECEm = Table.AddColumn(AddECPh,"Event Contact E-mail",       each [#"E-mail"], type text),
    // Same helper keys your sheet already uses (merge templates key off these):
    //   OnlineLiveSilent = Online & Live & Silent      e.g. "UnclearYesYes"
    //   Donation Methods = Online & Live & Silent & Raffle  e.g. "UnclearYesYesUnclear"
    AddOLS  = Table.AddColumn(AddECEm, "OnlineLiveSilent", each
                Text.Combine({[#"GCP - Online Auction"], [#"GCP - Live Auction"], [#"GCP - Silent Auction"]}), type text),
    AddDM   = Table.AddColumn(AddOLS, "Donation Methods", each
                Text.Combine({[#"GCP - Online Auction"], [#"GCP - Live Auction"], [#"GCP - Silent Auction"], [#"GCP - Raffle"]}), type text),
    // Complete = the sheet's original rule: Event Contact AND Event Contact Title are both filled in
    // (blanks were already turned into null in step 4, so checking for null covers empty cells too)
    AddDone = Table.AddColumn(AddDM, "Event Contact Information Complete", each
                if [Event Contact] <> null and [Event Contact Title] <> null then "Yes" else "No", type text),
    AddPG1  = Table.AddColumn(AddDone, "Primary Group 1", each
                if [#"GCP - Event Date Sort"] = null then null
                else Text.From(Date.Year([#"GCP - Event Date Sort"])) & " Events", type text),
    AddPG2  = Table.AddColumn(AddPG1, "Primary Group 2", each
                if [_src] <> null then [_src] else [_srcinfo], type text),

    // 7. Column with no Dataverse field yet (left blank so the layout matches)
    Blanks = Table.AddColumn(AddPG2, "Event Contact Person 2 - Employee or Volunteer", each null, type text),

    // 8. Exact order of your sheet
    Ordered = Table.SelectColumns(Blanks, {
        "Event ID", "GCP - Online Auction", "GCP - Live Auction", "GCP - Silent Auction", "GCP - Raffle",
        "GCP - Event Web Page", "GCP - Event Date Sort", "GCP - Beneficiary of Fundraiser", "GCP - Event",
        "Mailing Address 1", "Mailing Address 2", "Mailing Address 3", "Mailing City", "Mailing State", "Mailing Zip",
        "Phone - Business", "E-mail", "Contact", "Web Site", "Company", "First Seen",
        "Event Contact", "Event Contact Title", "Event Contact Phone Number", "Event Contact E-mail",
        "Employee or Volunteer", "Event Contact Person 2", "Event Contact Person 2 E-mail",
        "Event Contact Person 2 Phone Number", "Event Contact Person 2 - Employee or Volunteer",
        "Donation Methods", "OnlineLiveSilent", "Event Contact Information Complete",
        "Primary Group 1", "GCP - Event Status", "Primary Group 2"}),
    Sorted = Table.Sort(Ordered, {{"GCP - Event Date Sort", Order.Ascending}})
in
    Sorted
