# Copilot Instruction

- Do not introduce new frontend frameworks or libraries beyond the ACE editor for code editing and three.js for toolpath plotting. Stick to vanilla TypeScript, Web Components, and the existing tooling.
- Favor an instantiation service pattern for creating and wiring up application services and components. Centralize object creation logic instead of scattering `new` calls.
- Implement all new code in TypeScript. Ensure interfaces, classes, and modules use strong typing and exported TypeScript interfaces when sharing contracts.
- Build UI elements as Web Components (Custom Elements) written in TypeScript. Avoid adding React, Vue, Angular, or other component frameworks.
- Keep dependencies light; rely on browser APIs, TypeScript, ACE, and three.js only unless explicitly approved otherwise.
- Maintain consistent TypeScript module structure, using interfaces to describe contracts between services (e.g., parser, plotting, synchronization logic).
- Document complex customizations with concise comments explaining intent, especially around ACE editor extensions, instantiation wiring, and three.js integrations.
