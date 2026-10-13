// A Personalspace as `lazurio personalspace install` leaves it today: the
// files of Lazurio/PersonalspaceTemplate_GEN3 (public) at `main` cf50036,
// byte for byte, with the template's placeholders (`owner-github-username`,
// Lazurio/LazurioPlatform#377) and its example slot `workspace/personal-notes`,
// which declares no repository.

/** `modules.manifest.json` of the template. */
export const personalspaceTemplateManifest = `{
  "personal_generation": "gen3",
  "owner": "owner-github-username",
  "module_slots": [
    {
      "path": "workspace/personal-notes",
      "category": "knowledge",
      "default_access": "private",
      "required_roles": [
        "owner"
      ],
      "source_of_truth": "git-native",
      "notes": "Example personal module slot; replace or remove when creating real private nested modules."
    }
  ]
}
`;

/** The template's slots, as a reader parses them. */
export const personalspaceTemplateSlots: readonly unknown[] = Object.freeze(
  JSON.parse(personalspaceTemplateManifest).module_slots,
);
