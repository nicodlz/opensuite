import * as React from "react";
import * as Menu from "@radix-ui/react-dropdown-menu";

export const DropdownMenu = Menu.Root;
export const DropdownTrigger = Menu.Trigger;
export const DropdownItem = Menu.Item;
export const DropdownRadioGroup = Menu.RadioGroup;
export const DropdownRadioItem = Menu.RadioItem;
export const DropdownItemIndicator = Menu.ItemIndicator;
export function DropdownContent({ children }: { children: React.ReactNode }) {
  return (
    <Menu.Portal>
      <Menu.Content className="menu-content" align="end" sideOffset={8}>
        {children}
      </Menu.Content>
    </Menu.Portal>
  );
}
