export function NewChatWelcome({ projectName }: { projectName?: string }) {
  return (
    <div className="flex min-h-full flex-col items-center justify-center gap-5 px-6 py-12 text-center">
      <img
        src={`${import.meta.env.BASE_URL}app-icon.png`}
        alt=""
        aria-hidden="true"
        draggable={false}
        className="size-20 shrink-0 object-contain opacity-50 mix-blend-multiply grayscale dark:opacity-80 dark:mix-blend-screen dark:invert"
      />
      <h2 className="max-w-xl text-balance break-words text-[24px] font-normal leading-snug tracking-tight text-foreground sm:text-[26px]">
        {projectName ? (
          <>
            What should we build in <span className="underline decoration-border underline-offset-4">{projectName}</span>?
          </>
        ) : (
          'What should we build?'
        )}
      </h2>
    </div>
  );
}
