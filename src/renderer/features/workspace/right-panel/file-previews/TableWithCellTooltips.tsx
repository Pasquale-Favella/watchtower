import { type ComponentProps, type JSX, useState } from 'react'

import { Tooltip, TooltipContent } from '@/renderer/components/ui/tooltip'

export function TableWithCellTooltips(props: ComponentProps<'table'>): JSX.Element {
  const [cell, setCell] = useState<HTMLTableCellElement | null>(null)

  return (
    <>
      <table
        {...props}
        onPointerOver={event => {
          if (event.pointerType !== 'mouse' || !(event.target instanceof Element)) return
          setCell(event.target.closest<HTMLTableCellElement>('[data-cell-preview]'))
        }}
        onPointerLeave={() => setCell(null)}
      />
      <Tooltip
        disableHoverablePopup
        open={Boolean(cell?.isConnected && cell.textContent)}
        onOpenChange={open => {
          if (!open) setCell(null)
        }}
      >
        <TooltipContent anchor={cell} className="wrap-anywhere whitespace-pre-wrap">
          {cell?.textContent}
        </TooltipContent>
      </Tooltip>
    </>
  )
}
