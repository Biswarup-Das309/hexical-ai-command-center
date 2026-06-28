export function HexicalLogo({ className = "size-8" }: { className?: string }) {
  return (
    <svg 
      xmlns="http://www.w3.org/2000/svg" 
      viewBox="0 0 100 100" 
      className={className}
      fill="none"
    >
      <defs>
        {/* The Hexical Signature Gradient: Cyan to Deep Blue */}
        <linearGradient id="hexical-gradient" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#06b6d4" /> 
          <stop offset="50%" stopColor="#3b82f6" />
          <stop offset="100%" stopColor="#8b5cf6" />
        </linearGradient>
      </defs>

      {/* The Impossible Geometry Paths */}
      <path 
        d="M50 5 L90 27.5 L90 39 L50 16 L10 39 L10 27.5 L50 5 Z" 
        fill="url(#hexical-gradient)" 
        className="opacity-90 hover:opacity-100 transition-opacity duration-500"
      />
      <path 
        d="M90 72.5 L50 95 L10 72.5 L10 61 L50 84 L90 61 L90 72.5 Z" 
        fill="url(#hexical-gradient)" 
        className="opacity-80 hover:opacity-100 transition-opacity duration-500 delay-75"
      />
      <path 
        d="M10 33 L22 40 L22 60 L10 67 Z" 
        fill="url(#hexical-gradient)" 
        className="opacity-100"
      />
      <path 
        d="M90 33 L78 40 L78 60 L90 67 Z" 
        fill="url(#hexical-gradient)" 
        className="opacity-100"
      />
      
      {/* Central Core Element */}
      <circle cx="50" cy="50" r="6" fill="#06b6d4" className="animate-pulse" />
    </svg>
  )
}