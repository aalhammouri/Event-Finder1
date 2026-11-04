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
        {"lead_event_status",                  "GCP - Event Status"}
    },
    Kept    = Table.SelectColumns(Events, List.Transform(Map, each _{0}), MissingField.UseNull),
    Renamed = Table.RenameColumns(Kept, Map),

    // 3. Turn the 714000000-style codes into words
    YNU    = [#"714000000" = "Yes", #"714000001" = "No", #"714000002" = "Unclear"],
    EmpVol = [#"714000000" = "Employee", #"714000001" = "Volunteer"],
    Status = [#"714000100" = "Scheduled", #"714000101" = "Postponed", #"714000102" = "Cancelled",
              #"714000103" = "Already held", #"714000104" = "Unknown"],
    Label  = (m as record) => (v) => if v = null then null else Record.FieldOrDefault(m, Text.From(v), null),
    Decoded = Table.TransformColumns(Renamed, {
        {"GCP - Online Auction",  Label(YNU),    type text},
        {"GCP - Live Auction",    Label(YNU),    type text},
        {"GCP - Silent Auction",  Label(YNU),    type text},
        {"GCP - Raffle",          Label(YNU),    type text},
        {"Employee or Volunteer", Label(EmpVol), type text},
        {"GCP - Event Status",    Label(Status), type text}
    }),

    // 4. Clean text: trim, blank -> empty cell, drop "[GCP] " prefix from event names
    TextCols = List.Difference(Table.ColumnNames(Decoded), {"GCP - Event Date Sort", "First Seen"}),
    Trimmed  = Table.TransformColumns(Decoded,
                 List.Transform(TextCols, (c) => {c, each
                     let t = if _ = null then null else Text.Trim(Text.From(_))
                     in  if t = "" then null else t, type text})),
    NoPrefix = Table.TransformColumns(Trimmed, {{"GCP - Event",
                 each if _ <> null and Text.StartsWith(_, "[GCP] ") then Text.Middle(_, 6) else _, type text}}),
    // When no person was found, the scan put the org name in Contact; show blank instead
    RealContact = Table.ReplaceValue(NoPrefix, each [Contact], each if [Contact] = [Company] then null else [Contact],
                 Replacer.ReplaceValue, {"Contact"}),

    // 5. Dates only (no 12:00 PM time)
    Dated = Table.TransformColumns(RealContact, {
        {"GCP - Event Date Sort", each if _ = null then null else DateTime.Date(_), type date},
        {"First Seen",            each if _ = null then null else DateTime.Date(_), type date}
    }),

    // 6. Columns your sheet has that are built from other fields
    AddEC   = Table.AddColumn(Dated,  "Event Contact",              each [Contact], type text),
    AddECPh = Table.AddColumn(AddEC,  "Event Contact Phone Number", each [#"Phone - Business"], type text),
    AddECEm = Table.AddColumn(AddECPh,"Event Contact E-mail",       each [#"E-mail"], type text),
    AddOLS  = Table.AddColumn(AddECEm, "OnlineLiveSilent", each
                let parts = List.Select({
                        if [#"GCP - Online Auction"] = "Yes" then "Online" else null,
                        if [#"GCP - Live Auction"]   = "Yes" then "Live"   else null,
                        if [#"GCP - Silent Auction"] = "Yes" then "Silent" else null}, each _ <> null)
                in  if List.IsEmpty(parts) then null else Text.Combine(parts, "/"), type text),
    AddDone = Table.AddColumn(AddOLS, "Event Contact Information Complete", each
                if [Contact] <> null and [#"E-mail"] <> null and [#"Phone - Business"] <> null then "Yes" else "No", type text),

    // 7. Columns with no Dataverse field yet (left blank so the layout matches)
    Blanks = List.Accumulate({"Event Contact Person 2 - Employee or Volunteer", "Donation Methods",
                              "Primary Group 1", "Primary Group 2"},
                AddDone, (t, c) => Table.AddColumn(t, c, each null, type text)),

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
